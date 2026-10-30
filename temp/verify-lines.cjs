const fs = require('fs');
const R = 'E:/hello/StartOS/';
const CHECKS = [
  ['src/javascripts/finderbar.js', 591, '绑定'],
  ['src/javascripts/dock.js', 317, 'resolvable|废纸篓'],
  ['src/javascripts/controlcenter.js', 416, 'WebStartOS'],
  ['src/javascripts/controlcenter.js', 855, 'getBattery'],
  ['src/javascripts/spotlight.js', 117, 'ctrl\\+space'],
  ['src/javascripts/window-manager.js', 1200, 'tile|平铺|全屏'],
  ['src/javascripts/wm/frame.js', 296, 'TILE|region'],
  ['src/javascripts/session.js', 203, 'hideOthers'],
  ['src/javascripts/osfs.js', 33, '废纸篓'],
  ['src/javascripts/ui/notification.js', 41, 'banner|横幅|show'],
  ['src/javascripts/datetime_popover.js', 152, 'month|calendar|月'],
  ['mods/system-settings/panes/focus.js', 164, 'focus'],
  ['src/javascripts/wallpaper.js', 182, 'WALLPAPER|内置'],
  ['mods/system-settings/panes/display.js', 151, 'night|夜览|亮度'],
  ['src/javascripts/display.js', 53, 'brightness|nightShift'],
  ['mods/system-settings/panes/keyboard.js', 163, 'search|过滤|input'],
  ['assets/stylesheets/main/desktop.css', 47, 'stage-manager'],
  ['mods/launchpad/script.js', 1093, 'F4|key'],
  ['mods/system-settings/panes/general.js', 284, 'snapshot|备份|restore'],
  ['mods/system-settings/panes/storage.js', 315, 'appdata|scope|list'],
  ['src/javascripts/dock.js', 1528, 'stack|folder|栈'],
  ['src/javascripts/finderbar.js', 74, 'menu|MENU|defs'],
  ['src/javascripts/spotlight.js', 376, 'searchAll'],
  ['src/javascripts/window-manager.js', 1581, '刻意|保留'],
];
for (const [f, line, re] of CHECKS) {
  const src = fs.readFileSync(R + f, 'utf8').split('\n');
  const win = src.slice(line - 1, line + 2).join(' ');
  const hit = new RegExp(re, 'i').test(win);
  console.log((hit ? 'OK   ' : 'FAIL ') + f + ':' + line + '  ~ ' + src[line - 1].trim().slice(0, 78));
}
