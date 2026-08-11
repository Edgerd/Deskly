/**
 * 错误弹窗模块
 * 基于 WebSwift 自定义元素 swift-messagebox 实现 macOS 风格错误弹窗。
 * 按钮使用可控的自定义元素，避免 swift-button 内部 fill 被弹窗背景遮挡、
 * 以及按钮未居中显示的问题。
 */

let newAlert;

/**
 * 创建错误弹窗
 * @param {string} icon 图标路径
 * @param {string} title 标题
 * @param {string} text 正文内容（支持 HTML）
 * @param {string} btn 按钮文字
 * @param {"close"|"closepage"} command 点击按钮后的行为
 * @param {boolean} mobile 是否为移动端弹窗
 */
export function createAlert(icon, title, text, btn, command, mobile = false) {
    newAlert = document.createElement("swift-messagebox");
    newAlert.iconpath = icon;
    // 9610：高于 Dock（9500）与 Launchpad（9600），模态弹窗必须盖住它们
    newAlert.style.zIndex = 9610;

    // 使用可控的自定义按钮替代 swift-button，
    // 避免其内部 fill 元素 z-index 为负被弹窗背景遮挡、且未水平居中。
    const slotP = (name, html) => {
        const p = document.createElement("p");
        p.setAttribute("slot", name);
        p.innerHTML = html;
        newAlert.appendChild(p);
    };
    slotP("title", title);
    slotP("text", text);

    const newAlertButton = document.createElement("button");
    newAlertButton.className = "alert-btn";
    newAlertButton.setAttribute("slot", "button");
    newAlertButton.innerHTML = btn;

    if (command === "close") newAlertButton.onclick = () => { newAlert.style.display = "none"; };
    else if (command === "closepage") newAlertButton.onclick = () => { window.location.href = "about:blank"; window.close(); };

    newAlert.appendChild(newAlertButton);
    document.body.appendChild(newAlert);

    setTimeout(() => {
        newAlert.style.left = `${(document.body.clientWidth - newAlert.clientWidth) / 2}px`;
        newAlert.style.top = `${(document.body.clientHeight - newAlert.clientHeight) / 2}px`;
    }, 50);
}