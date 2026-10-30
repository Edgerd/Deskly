const fs = require('fs');
const path = require('path');
const ROOT = 'E:/hello/StartOS';
const DOC = path.join(ROOT, 'docs/手册对照_Deskly差异与改进建议.md');
let doc = fs.readFileSync(DOC, 'utf8');

const MAP = {
  'controlcenter.js': 'src/javascripts/controlcenter.js',
  'datetime_popover.js': 'src/javascripts/datetime_popover.js',
  'desktop.js': 'src/javascripts/desktop.js',
  'display.js': 'src/javascripts/display.js',
  'dock.js': 'src/javascripts/dock.js',
  'finderbar.js': 'src/javascripts/finderbar.js',
  'i18n.js': 'src/javascripts/i18n.js',
  'lock.js': 'src/javascripts/lock.js',
  'menuCommands.js': 'src/javascripts/ui/menuCommands.js',
  'os-api.js': 'src/javascripts/os-api.js',
  'osfs.js': 'src/javascripts/osfs.js',
  'plugin-manager.js': 'src/javascripts/plugin-manager.js',
  'registry.js': 'mods/system-settings/registry.js',
  'session.js': 'src/javascripts/session.js',
  'settings-definitions.js': 'src/javascripts/settings-definitions.js',
  'sound.js': 'src/javascripts/sound.js',
  'spotlight.js': 'src/javascripts/spotlight.js',
  'store-api.js': 'src/javascripts/store-api.js',
  'trashIcon.js': 'src/javascripts/trashIcon.js',
  'vendor.js': 'src/javascripts/vendor.js',
  'vfs.js': 'src/javascripts/vfs.js',
  'wallpaper.js': 'src/javascripts/wallpaper.js',
  'window-manager.js': 'src/javascripts/window-manager.js',
  'finder-actions.js': 'mods/finder/finder-actions.js',
  'finder-contextmenu.js': 'mods/finder/finder-contextmenu.js',
  'finder-views.js': 'mods/finder/finder-views.js',
  'desktop.css': 'assets/stylesheets/main/desktop.css',
  'main.css': 'assets/stylesheets/main/main.css',
};

const before = doc;
// 1. 半限定名 -> 全路径
doc = doc.replace(/(^|[^/\w.-])panes\//g, '$1mods/system-settings/panes/');
doc = doc.replace(/(^|[^/\w.-])wm\/frame\.js/g, '$1src/javascripts/wm/frame.js');
doc = doc.replace(/(^|[^/\w.-])codecs\//g, '$1mods/office/codecs/');
// 2. 裸文件名 -> 全路径
for (const [k, v] of Object.entries(MAP)) {
  doc = doc.split('`' + k + ':').join('`' + v + ':');
  doc = doc.split(' ' + k + ':').length > 1 ? doc : doc;
  doc = doc.replace(new RegExp('([^/\\w.-])' + k.replace(/\./g, '\\.') + ':', 'g'), '$1' + v + ':');
}
fs.writeFileSync(DOC, doc);
console.log('替换发生:', before !== doc, '| 剩余裸引用:', [...new Set([...doc.matchAll(/(^|[^/\w.-])([a-z0-9_.-]+\.(?:js|json|css|html)):/g)].map((m) => m[2]))].join(', '));
