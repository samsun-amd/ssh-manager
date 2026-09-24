// Run inside check-render.sh, or the editor's browser regression harness.
const result = {};
const visible = element => element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
const panels = [...doc.querySelectorAll('main > .panel')].map(e => e.getBoundingClientRect());
result['workspace panels do not overlap'] = panels.length === 3 && panels.every((a, i) => panels.slice(i + 1).every(b =>
  a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) ? true : 'Missing or overlapping panels';
result['primary controls can be clicked'] = ['pick-files', 'pick-folder', 'new-group', 'export'].every(id => {
  const e = doc.getElementById(id), box = e.getBoundingClientRect();
  return visible(e) && e.contains(doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
}) ? true : 'A primary control is hidden or covered';
result['default group is visible on load'] = visible(doc.querySelector('#groups button')) && doc.querySelector('#groups button').textContent.includes('default')
  ? true : 'Default group is missing or hidden';
const groupActions = doc.querySelector('.group-actions'), groupList = doc.getElementById('groups');
result['group actions are separated from group selection'] = groupActions &&
  ['new-group', 'edit-group', 'copy-group', 'delete-group'].every(id => groupActions.contains(doc.getElementById(id))) &&
  groupActions.getBoundingClientRect().top >= groupList.getBoundingClientRect().bottom &&
  parseFloat(win.getComputedStyle(groupActions).borderTopWidth) > 0 &&
  groupList.querySelector('[aria-pressed="true"]')?.classList.contains('active')
  ? true : 'Group actions need their own divided section below the selection list';
doc.getElementById('tab-raw').click();
result['Raw JSON tab shows the current group'] = visible(doc.getElementById('raw')) && doc.getElementById('editor-panel').hidden &&
  doc.getElementById('tab-raw').getAttribute('aria-selected') === 'true' &&
  JSON.parse(doc.getElementById('raw').textContent).group_number === win.SSHMEditor.state.groups[0].data.group_number
  ? true : 'Tab state or preview is inconsistent';
doc.getElementById('tab-editor').click();
return result;
