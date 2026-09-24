'use strict';
// Run with Node 22+. Browser checks use CHROME_BIN, or an existing Puppeteer cache.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const htmlPath = path.join(__dirname, 'sshm_config_editor.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = id => html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`))[1];
const context = vm.createContext({ TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView, Blob, DecompressionStream, console });
vm.runInContext(script('vendor'), context);
vm.runInContext(script('model'), context);
const M = context.SSHMModel, zip = context.fflate;
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/cli-test-inventory.json'), 'utf8'));
fixture.extra = { keep: false, zero: 0 };
fixture.nodes[0].custom = { note: '<img src=x onerror=alert(1)>', nested: [1, false, null] };
const bytes = data => new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
const input = (name, data) => { const b = data instanceof Uint8Array ? data : bytes(data); return { name, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS:', name); }
async function test(name, fn) { await fn(); checks++; console.log('PASS:', name); }
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshm-editor-test-'));
function tarArchive(groups, format = 'pax') {
  const spec = path.join(temporary, 'tar-spec.json'); fs.writeFileSync(spec, JSON.stringify(groups));
  const r = spawnSync('python3', ['-c', `import io,json,sys,tarfile
items=json.load(open(sys.argv[1])); out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT if sys.argv[2]=='pax' else tarfile.GNU_FORMAT) as t:
 for name,content in items.items():
  b=content.encode(); i=tarfile.TarInfo(name); i.size=len(b); t.addfile(i,io.BytesIO(b))
sys.stdout.buffer.write(out.getvalue())`, spec, format]);
  assert.equal(r.status, 0, r.stderr.toString()); return new Uint8Array(r.stdout);
}
async function modelTests() {
  let groups = await M.readInputs([input('ssh_remote_default.json', fixture)]);
  check('new format preserves unknown fields, false, zero and ordering', () => assert.deepEqual(plain(groups[0].data), fixture));
  const exported = M.outputs(groups);
  check('round-trip output is schema-compatible', () => assert.deepEqual(JSON.parse(exported[0].content), fixture));
  groups = await M.readInputs([input('legacy.json', fixture.nodes)]);
  check('legacy wraps once without changing nodes', () => { assert.equal(groups[0].legacy, true); assert.deepEqual(plain(groups[0].data.nodes), fixture.nodes); });
  await test('multiple legacy files are rejected', () => assert.rejects(M.readInputs([input('a.json', fixture.nodes), input('b.json', fixture.nodes)]), /Legacy/));
  await test('invalid JSON rejected', () => assert.rejects(M.readInputs([input('ssh_remote_bad.json', '{')])));
  await test('non-object node rejected', () => assert.rejects(M.readInputs([input('ssh_remote_bad.json', { group_number: 1, nodes: [null] })]), /nodes array/));
  const project = [{ id: 1, name: 'default', data: M.clone(fixture) }, { id: 2, name: 'tw', data: { group_number: 1, nodes: [] } }, { id: 3, name: 'us', data: { group_number: 2, nodes: [] } }];
  M.transfer(project, 1, [1, 0], [2, 3], false);
  check('copy to multiple groups preserves source order', () => { assert.deepEqual(plain(project[1].data.nodes), fixture.nodes.slice(0, 2)); assert.equal(project[0].data.nodes.length, 3); });
  project[1].data.nodes[0].custom.nested[0] = 9;
  check('copies are independently editable', () => { assert.equal(project[0].data.nodes[0].custom.nested[0], 1); assert.equal(project[2].data.nodes[0].custom.nested[0], 1); });
  M.transfer(project, 1, [0, 2], [2, 3], true);
  check('move removes exactly the selected source nodes', () => assert.deepEqual(plain(project[0].data.nodes), [fixture.nodes[1]]));
  check('invalid transfer leaves project intact', () => { const before = JSON.stringify(project); assert.throws(() => M.transfer(project, 1, [0], [2, 999], true)); assert.equal(JSON.stringify(project), before); });
  const a = { name: 'default', data: M.clone(fixture) }, b = { name: 'TW', data: { group_number: 1, nodes: [fixture.nodes[0]] } };
  check('Windows filenames are case-insensitive', () => assert.throws(() => M.outputs([b, { ...b, name: 'tw' }]), /Duplicate filename/));
  check('duplicate group number warns without blocking output', () => assert.equal(M.outputs([b, { ...b, name: 'us' }]).length, 2));
  check('invalid reserved number blocks output', () => assert.throws(() => M.outputs([{ ...b, data: { ...b.data, group_number: 0 } }])));
  check('unsafe group name cannot become an output path', () => assert.throws(() => M.outputs([{ ...b, name: '../escape' }])));
  const invalid = M.clone(a); invalid.data.nodes[0].port = 65536;
  check('invalid port blocks output', () => assert.throws(() => M.outputs([invalid]), /port/));
  const entries = { 'folder/ssh_remote_default.json': JSON.stringify(fixture), 'folder/ssh_remote_tw.json': JSON.stringify({ ...fixture, group_number: 1 }) };
  const zipped = zip.zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, bytes(v)])));
  for (const [name, data] of [['configs.zip', zipped], ['configs.tar', tarArchive(entries)], ['configs.tar.gz', zip.gzipSync(tarArchive(entries))], ['configs.tgz', zip.gzipSync(tarArchive(entries))]]) {
    await test(name + ' imports complete groups', async () => { const got = await M.readInputs([input(name, data)]); assert.equal(got.length, 2); assert.deepEqual(plain(got[0].data), fixture); });
  }
  for (const format of ['pax', 'gnu']) await test(format + ' long TAR filenames', async () => {
    const data = tarArchive({ ['x'.repeat(130) + '/ssh_remote_default.json']: JSON.stringify(fixture) }, format);
    assert.deepEqual(plain((await M.readInputs([input('long.tar', data)]))[0].data), fixture);
  });
  const unsafe = zip.zipSync({ '../ssh_remote_default.json': bytes(fixture) });
  await test('truncated ZIP footer rejected', () => assert.rejects(M.readInputs([input('broken.zip', zipped.subarray(0, zipped.length - 22))]), /ZIP/));
  const corruptZip = zip.zipSync({ 'ssh_remote_default.json': bytes(fixture) }, { level: 0 });
  corruptZip[30 + 'ssh_remote_default.json'.length + 1] ^= 1;
  await test('ZIP checksum verified', () => assert.rejects(M.readInputs([input('corrupt.zip', corruptZip)]), /checksum/));
  const corruptGzip = zip.gzipSync(tarArchive(entries)); corruptGzip[corruptGzip.length - 8] ^= 1;
  await test('GZIP checksum verified', () => assert.rejects(M.readInputs([input('corrupt.tgz', corruptGzip)])));
  await test('ZIP traversal rejected', () => assert.rejects(M.readInputs([input('unsafe.zip', unsafe)]), /Unsafe/));
  await test('TAR traversal rejected', () => assert.rejects(M.readInputs([input('unsafe.tar', tarArchive({ '../ssh_remote_default.json': JSON.stringify(fixture) }))]), /Unsafe/));
  const damaged = tarArchive(entries); damaged[0] ^= 1;
  await test('TAR checksum verified', () => assert.rejects(M.readInputs([input('bad.tar', damaged)]), /checksum/));
  await test('truncated TAR rejected', () => assert.rejects(M.readInputs([input('bad.tar', tarArchive(entries).subarray(0, 600))]), /truncated/i));
  await test('compressed expansion is bounded', () => assert.rejects(M.readInputs([input('bomb.tgz', zip.gzipSync(new Uint8Array(M.LIMIT + 1)))]), /32 MiB/));
  await test('folder ignores unrelated files', async () => { const got = await M.readInputs([input('folder/readme.json', {}), input('folder/ssh_remote_default.json', fixture)], true); assert.equal(got.length, 1); });
  await test('folder cannot import legacy arrays', () => assert.rejects(M.readInputs([input('folder/ssh_remote_default.json', fixture.nodes)], true), /Legacy/));
  fs.writeFileSync(path.join(temporary, 'legacy.json'), JSON.stringify(fixture.nodes));
  fs.writeFileSync(path.join(temporary, 'configs.zip'), zipped);
}
async function browserTests() {
  let chrome = process.env.CHROME_BIN;
  if (!chrome) {
    const cache = path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell');
    if (fs.existsSync(cache)) chrome = fs.readdirSync(cache).map(v => path.join(cache, v, 'chrome-headless-shell-linux64/chrome-headless-shell')).find(p => fs.existsSync(p));
  }
  if (!chrome) throw new Error('Set CHROME_BIN to run the required browser checks.');
  const userData = path.join(temporary, 'chrome');
  const child = spawn(chrome, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + userData, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    const portFile = path.join(userData, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await new Promise(r => setTimeout(r, 50));
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(htmlPath).href)}`, { method: 'PUT' })).json();
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0, dialogChoice = false; const pending = new Map(), errors = [], dialogs = [];
    ws.onmessage = e => { const msg = JSON.parse(e.data); if (msg.method === 'Page.javascriptDialogOpening') { dialogs.push(msg.params.type); send('Page.handleJavaScriptDialog', { accept: dialogChoice }).catch(error => errors.push(error.message)); } if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text); if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timeout); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timeout = setTimeout(() => { pending.delete(key); reject(new Error('Browser timeout: ' + method)); }, 15000); pending.set(key, { resolve, reject, timeout }); ws.send(JSON.stringify({ id: key, method, params })); });
    const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    await send('Runtime.enable');
    for (let i = 0; i < 100 && !(await evaluate('!!window.SSHMEditor')); i++) await new Promise(r => setTimeout(r, 50));
    check('HTML opens directly under file://', () => {}); assert.equal(await evaluate('!!window.SSHMEditor'), true);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const renderCheck = fs.readFileSync(path.join(__dirname, 'check-render.js'), 'utf8');
    const measure = () => evaluate(`(function(doc,win){${renderCheck}\n})(document,window)`);
    assert.ok(Object.values(await measure()).every(v => v === true));
    const faults = [
      ['workspace panels do not overlap', 'main>.panel{position:fixed;left:0;top:0}'],
      ['primary controls can be clicked', '#pick-files{visibility:hidden}'],
      ['default group is visible on load', '#groups{display:none}'],
      ['group actions are separated from group selection', '.group-actions{border-top:0}'],
      ['Raw JSON tab shows the current group', '#raw{display:none}']
    ];
    for (const [key, css] of faults) {
      await evaluate(`(()=>{const s=document.createElement('style');s.id='fault';s.textContent=${JSON.stringify(css)};document.head.append(s)})()`);
      assert.notEqual((await measure())[key], true, 'Assertion did not detect injected defect: ' + key);
      await evaluate('document.getElementById("fault").remove()');
    }
    check('rendering assertions detect injected visual defects', () => {});
    async function click(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); }
    async function upload(id, file) {
      const { root } = await send('DOM.getDocument'); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + id });
      await send('DOM.setFileInputFiles', { nodeId, files: [file] });
      for (let i = 0; i < 100 && !(await evaluate('document.getElementById("import-dialog").open')); i++) await new Promise(r => setTimeout(r, 30));
      assert.equal(await evaluate('document.getElementById("import-dialog").open'), true);
    }
    await upload('files', path.join(temporary, 'legacy.json'));
    assert.equal(await evaluate('document.querySelectorAll("#import-dialog input[type=radio]").length'), 0);
    await evaluate('document.getElementById("import-form").requestSubmit()');
    assert.equal(await evaluate('SSHMEditor.state.groups[0].name'), 'default');
    assert.deepEqual(await evaluate('SSHMEditor.state.groups[0].data'), { group_number: 0, nodes: fixture.nodes });
    check('legacy import directly creates editable default with unchanged nodes', () => {});
    await evaluate(`(()=>{const n=document.querySelector('#editor input[name="name"]');n.value='edited';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('tab-raw');
    assert.equal(await evaluate('JSON.parse(document.getElementById("raw").textContent).nodes[0].name'), 'edited');
    check('form changes update raw output without dropping unknown fields', () => {});
    assert.deepEqual(await evaluate('JSON.parse(document.getElementById("raw").textContent).nodes[0].custom'), fixture.nodes[0].custom);
    assert.equal(await evaluate('document.querySelectorAll("img").length'), 0);
    await click('new-group'); await evaluate('document.getElementById("group-name").value="tw";document.getElementById("group-number").value="1";document.getElementById("group-form").requestSubmit()');
    await click('new-group'); await evaluate('document.getElementById("group-name").value="us";document.getElementById("group-number").value="2";document.getElementById("group-form").requestSubmit()');
    await evaluate('SSHMEditor.choose(SSHMEditor.state.groups[0].id);SSHMEditor.state.selected=new Set([1]);SSHMEditor.render()');
    await click('transfer');
    await evaluate('document.querySelectorAll("#destinations input").forEach(i=>i.checked=true);document.getElementById("transfer-form").requestSubmit()');
    const split = await evaluate('SSHMEditor.state.groups.map(g=>g.data.nodes.map(n=>n.type))');
    assert.deepEqual(split, [['client', 'smc'], ['server', 'smc'], ['server', 'smc']]);
    check('UI moves to multiple groups and copies required SMC', () => {});
    // Model a parent and its child separately: reading/writing JSON in the parent is a failure.
    await evaluate(`
      window.__writes={};window.__folderExists=false;window.__folderCreates=0;window.__failFile='';
      window.__directory={name:'sshm_config',async *entries(){for(const key of Object.keys(__writes))yield [key.split('/')[1],{kind:'file'}]},
        async getFileHandle(name,{create=false}={}){
          if(name===__failFile)throw Error('disk full');
          const key='sshm_config/'+name;
          if(!create && !(key in __writes))throw new DOMException('Missing file','NotFoundError');
          return {async createWritable(){let value;return {async write(v){value=v},async close(){__writes[key]=value},async abort(){}}}};
        }};
      window.__parent={name:'output',async *entries(){throw Error('Unexpected parent scan')},getFileHandle(){throw Error('Unexpected parent write')},
        async getDirectoryHandle(name,{create=false}={}){
          if(name!=='sshm_config')throw Error('Wrong output folder');
          if(!__folderExists){if(!create)throw new DOMException('Missing folder','NotFoundError');__folderCreates++;__folderExists=true}
          return __directory;
        }};
      window.showDirectoryPicker=async()=>__parent;
    `);
    await click('export');
    for (let i=0;i<100 && !(await evaluate('document.getElementById("export-dialog").open'));i++) await new Promise(r=>setTimeout(r,10));
    assert.ok((await evaluate('document.getElementById("export-folder").textContent')).includes('output/sshm_config/'));
    assert.equal(await evaluate('window.__folderExists'),false);
    await evaluate('document.querySelector("#export-dialog [data-close]").click()');
    assert.equal(await evaluate('window.__folderExists'),false);
    check('cancelled export preview creates no output folder',()=>{});
    await click('export'); await new Promise(r=>setTimeout(r,30));
    await evaluate('document.getElementById("export-form").requestSubmit()');
    for(let i=0;i<100 && await evaluate('SSHMEditor.state.busy');i++) await new Promise(r=>setTimeout(r,10));
    const writes=await evaluate('window.__writes'); assert.equal(Object.keys(writes).length,3);
    assert.deepEqual(Object.keys(writes).sort(),['sshm_config/ssh_remote_default.json','sshm_config/ssh_remote_tw.json','sshm_config/ssh_remote_us.json']);
    assert.equal(await evaluate('window.__folderCreates'),1);
    fs.mkdirSync(path.join(temporary,'sshm_config'));
    for(const [name,content] of Object.entries(writes)) fs.writeFileSync(path.join(temporary,name),content);
    check('export creates sshm_config and writes three exact group JSON files inside it',()=> assert.deepEqual(JSON.parse(writes['sshm_config/ssh_remote_default.json']).nodes[0].custom,fixture.nodes[0].custom));
    const cli=spawnSync('bash',[path.join(__dirname,'../sshm'),'-g'],{env:{...process.env,SSHM_CONFIG_DIR:path.join(temporary,'sshm_config'),SSHM_CONFIG:''},encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr); assert.ok(cli.stdout.includes('tw')); assert.ok(!cli.stdout.includes('INVALID'));
    check('exported files load in the actual sshm CLI',()=>{});
    await evaluate(`window.__writes['sshm_config/ssh_remote_old.json']='keep'`);
    await click('export'); await new Promise(r=>setTimeout(r,30));
    assert.equal(await evaluate('document.getElementById("write-files").disabled'),true);
    assert.ok((await evaluate('document.getElementById("export-extra").textContent')).includes('ssh_remote_old.json'));
    const beforeOverwrite=await evaluate('JSON.stringify(window.__writes)');
    await evaluate('document.getElementById("export-form").requestSubmit()');
    assert.equal(await evaluate('JSON.stringify(window.__writes)'),beforeOverwrite);
    check('overwriting requires explicit confirmation',()=>{});
    await click('overwrite');await evaluate('document.getElementById("export-form").requestSubmit()');
    for(let i=0;i<100 && await evaluate('SSHMEditor.state.busy');i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await evaluate('document.getElementById("export-dialog").open'),false);
    assert.equal(await evaluate('window.__folderCreates'),1);
    assert.equal(await evaluate('window.__writes["sshm_config/ssh_remote_old.json"]'),'keep');
    check('confirmed export reuses sshm_config and preserves unrelated files',()=>{});
    // Exercise a partial export failure without pretending the whole folder is atomic.
    await evaluate(`window.__writes={};window.__failFile='ssh_remote_tw.json';SSHMEditor.touch()`);
    await click('export'); await new Promise(r=>setTimeout(r,30)); await evaluate('document.getElementById("export-form").requestSubmit()'); await new Promise(r=>setTimeout(r,30));
    assert.ok((await evaluate('document.getElementById("export-error").textContent')).includes('1/3')); assert.equal(await evaluate('SSHMEditor.state.dirty'),true);
    check('partial write failure keeps unsaved state and reports progress',()=>{});
    await evaluate('document.getElementById("export-dialog").close()');
    await evaluate(`window.__writes={};window.__failFile='';`);
    await click('export');await new Promise(r=>setTimeout(r,30));
    await evaluate(`window.__writes['sshm_config/ssh_remote_default.json']='appeared after preview';document.getElementById('export-form').requestSubmit()`);
    for(let i=0;i<100 && await evaluate('SSHMEditor.state.busy');i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await evaluate('window.__writes["sshm_config/ssh_remote_default.json"]'),'appeared after preview');
    assert.ok((await evaluate('document.getElementById("export-error").textContent')).includes('Destination changed'));
    check('files created after preview are not silently overwritten',()=>{});
    await evaluate('document.getElementById("export-dialog").close()');
    await evaluate(`window.showDirectoryPicker=async()=>({name:'conflict',async getDirectoryHandle(){throw new DOMException('sshm_config is a file','TypeMismatchError')}})`);
    await click('export');await new Promise(r=>setTimeout(r,30));
    assert.equal(await evaluate('document.getElementById("export-dialog").open'),false);
    assert.ok((await evaluate('document.getElementById("message").textContent')).includes('sshm_config is a file'));
    assert.equal(await evaluate('SSHMEditor.state.dirty'),true);
    check('a file named sshm_config blocks export without losing edits',()=>{});
    for (const name of ['AbortError', 'NotAllowedError']) {
      const before = await evaluate('JSON.stringify(SSHMEditor.state.groups)');
      await evaluate(`window.showDirectoryPicker=async()=>{throw new DOMException('test',${JSON.stringify(name)})}`);
      await click('export');
      assert.equal(await evaluate('JSON.stringify(SSHMEditor.state.groups)'), before);
      assert.equal(await evaluate('SSHMEditor.state.busy'), false);
      assert.equal(await evaluate('document.getElementById("export-dialog").open'), false);
    }
    check('cancelled or denied directory picker preserves edits',()=>{});
    await upload('files',path.join(temporary,'configs.zip'));
    await evaluate('document.getElementById("import-form").requestSubmit()');
    assert.equal(await evaluate('document.getElementById("import-dialog").open'),true);
    check('import collision does not silently replace edited groups',()=>{});
    await evaluate('document.getElementById("import-dialog").close();SSHMEditor.choose(SSHMEditor.state.groups[0].id)');
    await evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(fixture))}],'ssh_remote_drop.json'));document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))})()`);
    for (let i=0;i<100 && !(await evaluate('document.getElementById("import-dialog").open'));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await evaluate('SSHMEditor.state.pending[0].name'), 'drop');
    check('drag-and-drop JSON reaches the import preview',()=>{});
    await evaluate('document.getElementById("import-dialog").close()');
    const droppedFolder=path.join(temporary,'drag # % 中文 configs');
    fs.mkdirSync(path.join(droppedFolder,'nested configs'),{recursive:true});
    fs.writeFileSync(path.join(droppedFolder,'ssh_remote_real_drop.json'),JSON.stringify({...fixture,group_number:3}));
    fs.writeFileSync(path.join(droppedFolder,'nested configs','ssh_remote_nested_drop.json'),JSON.stringify({...fixture,group_number:4}));
    fs.writeFileSync(path.join(droppedFolder,'unrelated.txt'),'ignored');
    for(const type of ['dragEnter','dragOver','drop']) await send('Input.dispatchDragEvent',{type,x:100,y:100,data:{items:[],files:[droppedFolder],dragOperationsMask:1}});
    for(let i=0;i<100 && !(await evaluate('document.getElementById("import-dialog").open'));i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(await evaluate('document.getElementById("import-dialog").open'),true,await evaluate('document.getElementById("message").textContent'));
    assert.deepEqual(await evaluate('SSHMEditor.state.pending.map(g=>g.name).sort()'),['nested_drop','real_drop']);
    assert.deepEqual(await evaluate('SSHMEditor.state.pending.find(g=>g.name==="real_drop").data'),{...fixture,group_number:3});
    check('real nested folder drop works under file:// without relaxed browser security flags',()=>{});
    await evaluate('document.getElementById("import-dialog").close()');
    // The actual folder drop above covers browser access; inject an interrupted iterator here.
    const beforeFolderFailure=await evaluate('JSON.stringify(SSHMEditor.state.groups)');
    await evaluate(`(()=>{
      const folder={kind:'directory',name:'blocked',async *values(){throw new DOMException('Folder access denied','NotAllowedError')}};
      const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{kind:'file',getAsFileSystemHandle:async()=>folder}]}});document.dispatchEvent(event);
    })()`);
    for(let i=0;i<100 && await evaluate('SSHMEditor.state.busy');i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await evaluate('JSON.stringify(SSHMEditor.state.groups)'),beforeFolderFailure);
    assert.equal(await evaluate('document.getElementById("import-dialog").open'),false);
    assert.ok((await evaluate('document.getElementById("message").textContent')).includes('Folder access denied'));
    check('folder access failure preserves edits and restores controls',()=>{});
    // Keep screenshot data synthetic; no private inventory is imported here.
    await click('tab-editor');
    const shot=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(temporary,'editor.png'),Buffer.from(shot.data,'base64'));
    if(process.env.EDITOR_SCREENSHOT)fs.copyFileSync(path.join(temporary,'editor.png'),process.env.EDITOR_SCREENSHOT);
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),true);
    }
    check('desktop and narrow layouts avoid page overflow',()=>{});
    await click('new-group'); await evaluate('document.getElementById("group-name").value="new_config";document.getElementById("group-form").requestSubmit()');
    await evaluate('document.getElementById("new-type").value="server"');await click('add-node');
    await evaluate(`(()=>{
      const edit=(label,value)=>{const n=document.querySelector('#editor [aria-label="'+label+'"]');n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}))};
      edit('Node name','fresh');edit('bmc IP / hostname','192.0.2.9');edit('bmc User','test');
      [...document.querySelectorAll('#editor button')].find(b=>b.textContent==='新增 host').click();
      edit('host1 IP / hostname','192.0.2.10');edit('host1 User','hostuser');
    })()`);
    await click('tab-raw');
    const created=await evaluate('JSON.parse(document.getElementById("raw").textContent)');
    assert.equal(created.nodes[0].hosts[0].ip,'192.0.2.10'); assert.equal(created.nodes[0].bmc.user,'test');
    await new Promise(r=>setTimeout(r,250));
    assert.equal(await evaluate('document.getElementById("export").disabled'),false);
    check('new server and host can be authored entirely through forms',()=>{});
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await click('tab-editor');
    const beforeSmc=await evaluate('JSON.stringify(SSHMEditor.state.groups.at(-1).data)');
    const addSmc=`[...document.querySelectorAll('#editor button')].find(b=>b.textContent==='新增 embedded SMC（core 格式）')`;
    const removeSmc=`document.querySelector('#editor [aria-label="刪除 embedded SMC"]')`;
    await evaluate(`(()=>{const b=${addSmc};b.scrollIntoView({block:'center'});b.click()})()`);
    dialogChoice=false;await evaluate(`${removeSmc}.click()`);
    assert.equal(await evaluate('Object.hasOwn(SSHMEditor.state.groups.at(-1).data.nodes[0],"smc")'),true);
    dialogChoice=true;await evaluate(`${removeSmc}.click()`);
    assert.equal(await evaluate('JSON.stringify(SSHMEditor.state.groups.at(-1).data)'),beforeSmc);
    assert.deepEqual(dialogs.slice(-2),['confirm','confirm']);
    await click('tab-raw');
    assert.equal(await evaluate('Object.hasOwn(JSON.parse(document.getElementById("raw").textContent).nodes[0],"smc")'),false);
    check('SMC removal confirms deletion and preserves BMC and hosts',()=>{});
    await click('tab-editor');
    await evaluate(`(()=>{const b=${addSmc};b.scrollIntoView({block:'center'});b.click()})()`);
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
      const smcLayout=await evaluate(`(()=>{const h=[...document.querySelectorAll('#editor h3')].find(h=>h.textContent==='Embedded SMC · core');const b=${removeSmc};b.scrollIntoView({block:'center'});const box=b.getBoundingClientRect();return {headingY:h.getBoundingClientRect().y,buttonY:box.y,clickable:b.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))}})()`);
      assert.ok(Math.abs(smcLayout.buttonY-smcLayout.headingY)<20,'SMC removal must be beside its section heading');
      assert.equal(smcLayout.clickable,true);
    }
    check('SMC removal stays beside its heading and is clickable at both viewport widths',()=>{});
    await evaluate(`(()=>{const n=SSHMEditor.state.groups.at(-1).data.nodes[0];n.smc={ip:'192.0.2.20',user:'test',pass:'synthetic',custom:{keep:true}};SSHMEditor.render()})()`);
    dialogChoice=true;await evaluate(`${removeSmc}.click()`);
    await click('tab-raw');
    assert.equal(await evaluate('JSON.stringify(JSON.parse(document.getElementById("raw").textContent))'),beforeSmc);
    const withoutSmc=await evaluate('JSON.parse(SSHMModel.outputs([SSHMEditor.state.groups.at(-1)])[0].content)');
    assert.equal(Object.hasOwn(withoutSmc.nodes[0],'smc'),false);
    assert.equal(await evaluate('SSHMEditor.state.dirty'),true);
    check('removing a populated SMC removes the whole block from raw and exported JSON',()=>{});
    await evaluate('SSHMEditor.choose(SSHMEditor.state.groups[0].id)');
    const perf=await evaluate(`(()=>{const g=SSHMEditor.state.groups[0];g.data.nodes=Array.from({length:5000},(_,i)=>({type:'client',name:'node'+i,ip:'host'+i,user:'test'}));const t=performance.now();SSHMEditor.render();document.getElementById('tab-raw').click();return {ms:performance.now()-t,rows:document.querySelectorAll('.node-row').length,raw:JSON.parse(document.getElementById('raw').textContent).nodes.length}})()`);
    assert.equal(perf.rows,100);assert.equal(perf.raw,5000);assert.ok(perf.ms<1500,JSON.stringify(perf));
    console.log('5000-node render + raw preview:',Math.round(perf.ms),'ms');check('large inventory is paginated with accurate raw preview',()=>{});
    check('browser has no uncaught script errors',()=>assert.deepEqual(errors,[]));
  } finally { ws?.close(); if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));} }
}
(async()=>{try{await modelTests();await browserTests();console.log(`${checks} checks passed`);}finally{fs.rmSync(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
