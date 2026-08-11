let audio = new Audio("./assets/sounds/alert.ogg");

export function createNotification(icon, title, text, command, time = "刚刚") {
    try { audio.play()?.catch?.(() => {}); } catch { /* 自动播放策略可能拒绝，忽略 */ }

    const el = document.createElement("swift-notification");
    el.iconpath = icon;
    Object.assign(el.style, { zIndex: 9610, top: "34px" });
    const notifImg = el.shadowRoot && el.shadowRoot.querySelector("img");
    if (notifImg) notifImg.src = icon;

    const slot = (name, html) => {
        const p = document.createElement("p");
        p.setAttribute("slot", name);
        p.innerHTML = html;
        el.appendChild(p);
    };
    slot("title", title);
    slot("text", text);
    slot("time", time);
    el.onclick = command;
    document.body.appendChild(el);
    setTimeout(() => {
        el.classList.add("close");
        setTimeout(() => el.remove(), 400);
    }, 5500);
}