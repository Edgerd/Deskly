/**
 * panes/sound.js — 「系统设置 › 声音」面板
 *
 * sound.master / sound.muted 的定义与生效函数都在 sound.js（owner 才是取值权威），
 * 这里只通过设置中枢读写，所以与控制中心的音量滑块、静音按钮改的是同一份值。
 *
 * 「输出设备」下拉不做：浏览器只有 Web Audio / setSinkId 这类按元素输出的能力，
 * 没有全站输出设备枚举接口，硬做一个下拉就是假控件 —— 改成一行只读状态。
 */

import { sound } from "../../../src/javascripts/sound.js";
import {
    t, el, group, controlSwitch, controlSlider, actionRow, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "sound";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            sound: {
                outputGroup: "输出",
                master: "音量",
                muted: "静音",
                device: "输出设备",
                deviceValue: "跟随浏览器",
                testGroup: "试听",
                test: "播放测试音",
                testBtn: "播放",
            },
        },
    },
    "en": {
        ss: {
            sound: {
                outputGroup: "Output",
                master: "Volume",
                muted: "Mute",
                device: "Output device",
                deviceValue: "Browser default",
                testGroup: "Test",
                test: "Play test tone",
                testBtn: "Play",
            },
        },
    },
    "ja-JP": {
        ss: {
            sound: {
                outputGroup: "出力",
                master: "音量",
                muted: "ミュート",
                device: "出力デバイス",
                deviceValue: "ブラウザ既定",
                testGroup: "試聴",
                test: "テスト音を再生",
                testBtn: "再生",
            },
        },
    },
    cat: {
        ss: {
            sound: {
                outputGroup: "出声的地方喵",
                master: "主音量",
                muted: "静音",
                device: "输出设备",
                deviceValue: "听浏览器的",
                testGroup: "听一下喵",
                test: "播放测试音",
                testBtn: "放来听喵",
            },
        },
    },
};

const CSS = `
.ss-sound .ss-status__value { font-variant-numeric: tabular-nums; }
`;

/**
 * 构建声音面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const deviceRow = statusRow({
        label: t("ss.sound.device", "输出设备"),
        value: t("ss.sound.deviceValue", "跟随浏览器"),
    });

    return el("div", { class: "ss-pane ss-sound" },
        group([
            controlSlider("sound.master", {
                label: t("ss.sound.master", "音量"),
                min: 0, max: 1, step: 0.01, format: "percent",
            }),
            controlSwitch("sound.muted", { label: t("ss.sound.muted", "静音") }),
            deviceRow,
        ], { title: t("ss.sound.outputGroup", "输出") }),

        group([
            actionRow({
                label: t("ss.sound.test", "播放测试音"),
                buttonText: t("ss.sound.testBtn", "播放"),
                onAction: () => {
                    if (typeof sound?.playTone !== "function") {
                        throw new Error("sound.playTone unavailable");
                    }
                    sound.playTone("alert");
                },
            }),
        ], { title: t("ss.sound.testGroup", "试听") })
    );
}

/** 声音面板没有自持有的资源需要释放。 */
export function destroy() { }
