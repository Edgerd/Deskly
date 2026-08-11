import { createAlert } from "./ui/alert.js";

function isMobileDevice() {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    const mobileRegex = /android|iphone|ipod|blackberry|iemobile|opera mini|mobile|windows phone|phone|webos|kindle|tablet/i;
    return mobileRegex.test(ua.toLowerCase());
}

function clientCheck() {
    if (isMobileDevice()) {
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        document.body.append(overlay);
        document.body.style.overflow = "hidden";
        createAlert("./assets/icons/Finder.png", "客户端不兼容", "请使用电脑端访问 Deskly", "好", "closepage", true);
        document.querySelector(".dock").style.display = "none";
    }
}

window.onload = clientCheck