/**
 * script.js — Siri Orb（Three.js / iOS 18 风格）
 *
 * 完全参照 iOS 18 Siri Orb 实现：渐变光带（Lissajous 运动 + 着色器渐变）
 * + 外层辉光球体（菲涅尔 + 色彩循环）+ UnrealBloom 泛光。
 *
 * 容器为右上角悬浮面板（顶栏下方、靠右，非满屏黑底），通过 window.__siri 暴露 open/close/toggle。
 * Three.js 通过相对路径本地加载（MV3 扩展 CSP 禁止内联 importmap，故改用相对路径），
 * 仅在首次打开时加载一次；关闭仅停渲染循环，窗口卸载（plugin-unload）时才释放 GPU 与面板 DOM。
 *
 * 设置全部走设置中枢（window.__settings），插件侧不再直接碰 localStorage：
 * siri.orb.size（内核定义，本插件只读+回写）、siri.wakeSound 与 siri.orbGlow（本插件
 * 自带定义，owner: "siri" 故系统设置「插件」面板自动出开关）。三项都有真实的视觉效果。
 */

(function () {
  "use strict";

  // 单实例守卫：本脚本既被顶栏（finderbar 直接 import）加载，也会被 plugin-manager
  // 每次打开注入一份新实例（?v= 不同 → 不同模块）。重复绑定全局监听会永久累积，
  // 故已有实例时直接复用其接口，本实例立即退出。
  if (window.__siri) return;

  // 注入插件样式。Siri 不创建窗口，plugin-manager 的 load() 同样会注入 plugin-style-siri，
  // 因此仅在被顶栏直接 import（无 loader 参与）时才自注入，避免同一份 CSS 进两次 CSSOM。
  function ensureStyle() {
    if (document.getElementById("siri-style") || document.getElementById("plugin-style-siri")) return;
    const link = document.createElement("link");
    link.id = "siri-style";
    link.rel = "stylesheet";
    link.href = new URL("./style.css", import.meta.url).href;
    document.head.appendChild(link);
  }
  ensureStyle();

  // 悬浮面板边长（正方形，Orb 居中渲染）；可由系统设置「Siri」页调整
  const DEFAULT_ORB_SIZE = 150;
  const ORB_SIZE_MIN = 80;
  const ORB_SIZE_MAX = 300;

  /** 泛光的基准参数：siri.orbGlow 关闭时按此比例衰减，重建场景后仍然一致。 */
  const BLOOM_STRENGTH = 0.8;
  const BLOOM_RADIUS = 0.3;
  const BLOOM_THRESHOLD = 0.85;

  /** 插件自有设置的当前值（由 registerPluginSettings 与设置中枢对齐）。 */
  const FLAGS = { wakeSound: true, orbGlow: true };

  /**
   * 注册本插件自带的两个设置项（siri.wakeSound / siri.orbGlow）。
   * owner 标为 "siri"、pane 标为 "plugins"：系统设置的「插件」面板据此自动渲染开关，
   * 插件不必自绘任何设置界面。设置中枢缺席（被单独页面引用）时整体跳过，功能不缺。
   * @returns {boolean} 是否完成注册
   */
  function registerPluginSettings() {
    const api = globalThis.__settings;
    if (!api || typeof api.defineMany !== "function") return false;
    api.defineMany([
      {
        key: "siri.wakeSound", type: "boolean", default: true,
        owner: "siri", pane: "plugins", group: "Siri", order: 20, control: "switch",
        label: "唤醒提示音", hint: "打开光球时播一声提示音（音量跟随系统主音量）",
        apply: (value) => { FLAGS.wakeSound = Boolean(value); },
      },
      {
        key: "siri.orbGlow", type: "boolean", default: true,
        owner: "siri", pane: "plugins", group: "Siri", order: 30, control: "switch",
        label: "光球辉光", hint: "外层辉光球与泛光强度；关闭后只剩渐变光带",
        apply: (value) => { FLAGS.orbGlow = Boolean(value); applyGlow(); },
      },
    ]);
    FLAGS.wakeSound = Boolean(api.get("siri.wakeSound"));
    FLAGS.orbGlow = api.get("siri.orbGlow") !== false;
    return true;
  }

  /** 读取已保存的 Orb 边长（px），越界或缺失回退默认值。设置中枢优先，退回旧槽名。 */
  function getStoredSize() {
    const api = globalThis.__settings;
    if (api && typeof api.get === "function") {
      const value = Number(api.get("siri.orb.size", DEFAULT_ORB_SIZE));
      if (Number.isFinite(value)) return Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, Math.round(value)));
    }
    let v = DEFAULT_ORB_SIZE;
    try {
      const raw = localStorage.getItem("siri-orb-size");
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) v = n;
      }
    } catch (e) {}
    return Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, v));
  }

  const STATE = window.__siriState || (window.__siriState = {
    isOpen: false,
    isClosing: false,
    isOpening: false,
    panelEl: null,
    renderer: null,
    composer: null,
    bloom: null, // UnrealBloomPass：siri.orbGlow 直接调它的强度
    scene: null,
    camera: null,
    ribbons: [],
    glowSphere: null,
    animationId: null,
    bindFrame: null, // 延迟挂载全局监听的 rAF 句柄
    closeTimer: null,
    loaded: false, // three 是否已加载并构建场景
    size: getStoredSize(), // 当前 Orb 边长（px），由设置调整
    session: 0, // 会话代次：卸载后自增，用于丢弃迟到的异步初始化结果
  });

  /**
   * 确保悬浮面板 DOM 存在且唯一（幂等）。
   * 面板可能来自 index.html 注入，也可能由本函数创建；本插件无窗口，
   * plugin-manager 的 unload 按 id 找不到它，所以重复注入留下的多余节点须自行收敛。
   * @returns {HTMLDivElement}
   */
  function ensurePanel() {
    let panel = STATE.panelEl && STATE.panelEl.isConnected ? STATE.panelEl : document.querySelector(".siri-panel");
    document.querySelectorAll(".siri-panel").forEach((el) => { if (el !== panel) el.remove(); });
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "siri-panel";
      panel.id = "siri-panel";
      const canvas = document.createElement("canvas");
      canvas.id = "siri-canvas";
      panel.appendChild(canvas);
      document.body.appendChild(panel);
    }
    if (panel.id !== "siri-panel") panel.id = "siri-panel";
    // 内联尺寸可能来自上一次会话或静态标记，统一按当前 STATE.size 对齐
    panel.style.width = STATE.size + "px";
    panel.style.height = STATE.size + "px";
    STATE.panelEl = panel;
    return panel;
  }

  /**
   * 首次打开时异步加载 three 与 addons，构建场景（完全参照用户提供的实现）。
   * @param {HTMLCanvasElement} canvas
   */
  async function initThree(canvas) {
    const THREE = await import("./vendor/three.module.js");
    const { EffectComposer } = await import("./vendor/jsm/postprocessing/EffectComposer.js");
    const { RenderPass } = await import("./vendor/jsm/postprocessing/RenderPass.js");
    const { UnrealBloomPass } = await import("./vendor/jsm/postprocessing/UnrealBloomPass.js");
    const { ShaderPass } = await import("./vendor/jsm/postprocessing/ShaderPass.js");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000); // aspect=1（正方形面板）
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(STATE.size, STATE.size);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.position.z = 4;

    // 后期处理：RenderPass + UnrealBloom
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(STATE.size, STATE.size),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD
    );
    composer.addPass(bloomPass);
    STATE.bloom = bloomPass;

    // 透明背景修复：UnrealBloom 末级合成会强制输出 alpha=1，导致黑底方块。
    // 追加末级 ShaderPass，以像素亮度作为 alpha，使黑底变透明、仅保留发光 Orb。
    const finalPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `
          uniform sampler2D tDiffuse;
          varying vec2 vUv;
          void main() {
            vec4 tex = texture2D(tDiffuse, vUv);
            float a = max(max(tex.r, tex.g), tex.b);
            gl_FragColor = vec4(tex.rgb, a);
          }
        `,
      }),
      "tDiffuse"
    );
    composer.addPass(finalPass);
    renderer.setClearColor(0x000000, 0);

    // ---------- 渐变光带着色器（原样移植） ----------
    const ribbonVertexShader = `
      varying vec2 vUv;
      varying vec3 vPosition;
      void main() {
        vUv = uv;
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const ribbonFragmentShader = `
      uniform vec3 color1;
      uniform vec3 color2;
      uniform float time;
      uniform float opacity;
      uniform float saturation;
      varying vec2 vUv;
      varying vec3 vPosition;
      vec3 adjustSaturation(vec3 color, float sat) {
        float gray = dot(color, vec3(0.299, 0.587, 0.114));
        return mix(vec3(gray), color, sat);
      }
      void main() {
        float gradient = vUv.y;
        float flow = sin(vUv.x * 3.14159 + time) * 0.5 + 0.5;
        gradient = mix(gradient, flow, 0.3);
        vec3 color = mix(color1, color2, gradient);
        color = adjustSaturation(color, saturation);
        float edgeFade = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
        edgeFade *= smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
        float glow = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 2.0);
        color += color * glow * 0.3;
        float distFromCenter = length(vPosition);
        float boundaryRadius = 2.0;
        float boundaryFade = smoothstep(boundaryRadius + 0.3, boundaryRadius - 0.2, distFromCenter);
        float finalOpacity = opacity * edgeFade * boundaryFade;
        gl_FragColor = vec4(color, finalOpacity);
      }
    `;

    function createPringleRibbon(width, height, curvature) {
      const geometry = new THREE.PlaneGeometry(width, height, 32, 32);
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = (x * x - y * y) * curvature;
        positions.setZ(i, z);
      }
      geometry.computeVertexNormals();
      return geometry;
    }

    const ribbonConfigs = [
      { color1: [0.0, 0.9, 1.0], color2: [0.0, 0.5, 0.8], curvature: 0.30, speed: 1.0,
        lissajous: { ax: 1, ay: 2, az: 3, rx: 2, ry: 3, rz: 1 } },
      { color1: [0.2, 0.4, 1.0], color2: [0.1, 0.2, 0.7], curvature: 0.25, speed: 0.8,
        lissajous: { ax: 2, ay: 3, az: 1, rx: 1, ry: 2, rz: 3 } },
      { color1: [0.6, 0.2, 1.0], color2: [0.4, 0.1, 0.6], curvature: 0.35, speed: 1.2,
        lissajous: { ax: 3, ay: 1, az: 2, rx: 3, ry: 1, rz: 2 } },
      { color1: [1.0, 0.3, 0.8], color2: [0.8, 0.1, 0.5], curvature: 0.28, speed: 0.9,
        lissajous: { ax: 1, ay: 3, az: 2, rx: 2, ry: 1, rz: 3 } },
      { color1: [0.1, 0.8, 0.9], color2: [0.2, 0.6, 1.0], curvature: 0.32, speed: 1.1,
        lissajous: { ax: 2, ay: 1, az: 3, rx: 3, ry: 2, rz: 1 } },
      { color1: [0.8, 0.4, 1.0], color2: [0.5, 0.2, 0.8], curvature: 0.27, speed: 0.85,
        lissajous: { ax: 3, ay: 2, az: 1, rx: 1, ry: 3, rz: 2 } },
    ];

    const ribbons = [];
    ribbonConfigs.forEach((config, index) => {
      const geometry = createPringleRibbon(3, 3, config.curvature);
      const material = new THREE.ShaderMaterial({
        vertexShader: ribbonVertexShader,
        fragmentShader: ribbonFragmentShader,
        uniforms: {
          color1: { value: new THREE.Vector3(...config.color1) },
          color2: { value: new THREE.Vector3(...config.color2) },
          time: { value: 0 },
          opacity: { value: 0.4 },
          saturation: { value: 1.91 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      const initialRotationX = (index / ribbonConfigs.length) * Math.PI * 2 * 0.7;
      const initialRotationY = (index / ribbonConfigs.length) * Math.PI * 2 * 0.5;
      const initialRotationZ = (index / ribbonConfigs.length) * Math.PI * 2 * 0.3;
      mesh.rotation.x = initialRotationX;
      mesh.rotation.y = initialRotationY;
      mesh.rotation.z = initialRotationZ;
      mesh.userData = {
        speed: config.speed,
        phaseOffset: index * (Math.PI * 2 / ribbonConfigs.length),
        initialRotation: { x: initialRotationX, y: initialRotationY, z: initialRotationZ },
        posAmplitude: 0.10,
        lissajousPos: { ax: config.lissajous.ax, ay: config.lissajous.ay, az: config.lissajous.az },
        rotAmplitude: 0.5,
        lissajousRot: { rx: config.lissajous.rx, ry: config.lissajous.ry, rz: config.lissajous.rz },
      };
      scene.add(mesh);
      ribbons.push(mesh);
    });

    // ---------- 外层辉光球体（原样移植） ----------
    const glowGeometry = new THREE.SphereGeometry(2.3, 64, 64);
    const glowMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        #define TAU 6.28318530718
        uniform float time;
        uniform float saturation;
        uniform float rotationSpeed;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        vec3 adjustSaturation(vec3 color, float sat) {
          float gray = dot(color, vec3(0.299, 0.587, 0.114));
          return mix(vec3(gray), color, sat);
        }
        void main() {
          vec3 pos = vWorldPosition;
          float rotationOffset = time * rotationSpeed;
          float angle = atan(pos.z, pos.x) + rotationOffset;
          float normalizedAngle = fract(angle / TAU + 0.5);
          vec3 color1 = vec3(0.0, 0.8, 1.0);
          vec3 color2 = vec3(0.2, 0.4, 1.0);
          vec3 color3 = vec3(0.6, 0.2, 1.0);
          vec3 color4 = vec3(1.0, 0.3, 0.8);
          float t = normalizedAngle * 4.0;
          float segment = floor(t);
          float blend = fract(t);
          blend = smoothstep(0.0, 1.0, blend);
          vec3 glowColor;
          if (segment < 1.0) { glowColor = mix(color1, color2, blend); }
          else if (segment < 2.0) { glowColor = mix(color2, color3, blend); }
          else if (segment < 3.0) { glowColor = mix(color3, color4, blend); }
          else { glowColor = mix(color4, color1, blend); }
          glowColor = adjustSaturation(glowColor, saturation);
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
          float fresnel = pow(1.0 - abs(dot(viewDirection, vNormal)), 3.0);
          float pulse = sin(time * 1.5) * 0.2 + 0.8;
          glowColor *= pulse;
          float alpha = fresnel * 0.25;
          gl_FragColor = vec4(glowColor * fresnel, alpha);
        }
      `,
      uniforms: {
        time: { value: 0 },
        saturation: { value: 1.91 },
        rotationSpeed: { value: 0.0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const glowSphere = new THREE.Mesh(glowGeometry, glowMaterial);
    scene.add(glowSphere);

    // 存入 STATE 供动画循环与后续复用
    STATE.scene = scene;
    STATE.camera = camera;
    STATE.renderer = renderer;
    STATE.composer = composer;
    STATE.ribbons = ribbons;
    STATE.glowSphere = glowSphere;
    STATE.loaded = true;
    applyGlow(); // 场景每重建一次都要按 siri.orbGlow 归一次位
  }

  /** 启动渲染循环 */
  function startLoop() {
    if (STATE.animationId != null) return;
    const { scene, camera, composer, ribbons, glowSphere } = STATE;
    function animate() {
      STATE.animationId = requestAnimationFrame(animate);
      const time = Date.now() * 0.001;
      ribbons.forEach((ribbon, index) => {
        const userData = ribbon.userData;
        const t = time * userData.speed * 0.5;
        const phase = userData.phaseOffset;
        const posX = userData.posAmplitude * Math.sin(userData.lissajousPos.ax * t + phase);
        const posY = userData.posAmplitude * Math.sin(userData.lissajousPos.ay * t + phase + Math.PI / 3);
        const posZ = userData.posAmplitude * Math.sin(userData.lissajousPos.az * t + phase + Math.PI / 2);
        ribbon.position.set(posX, posY, posZ);
        ribbon.rotation.x = userData.initialRotation.x + userData.rotAmplitude * Math.sin(userData.lissajousRot.rx * t + phase);
        ribbon.rotation.y = userData.initialRotation.y + userData.rotAmplitude * Math.sin(userData.lissajousRot.ry * t + phase + Math.PI / 4);
        ribbon.rotation.z = userData.initialRotation.z + userData.rotAmplitude * Math.sin(userData.lissajousRot.rz * t + phase + Math.PI / 6);
        const scale = 1.0 + Math.sin(t * 2.0 + phase) * 0.08;
        ribbon.scale.set(scale, scale, scale);
        ribbon.material.uniforms.time.value = t + phase;
      });
      glowSphere.material.uniforms.time.value = time;
      glowSphere.rotation.y += 0.002;
      glowSphere.rotation.x = Math.cos(time * 0.2) * 0.1;
      composer.render();
    }
    animate();
  }

  /** 停止渲染循环（仅停帧，资源留给 disposeScene） */
  function stopLoop() {
    if (STATE.animationId != null) {
      cancelAnimationFrame(STATE.animationId);
      STATE.animationId = null;
    }
  }

  /**
   * 释放 GPU 与场景资源：three 的几何体/材质/合成器 renderTarget 不会随节点移除自动回收，
   * WebGL 上下文也只有 forceContextLoss 才真正归还显存。调用后 STATE 复位，下次打开重建场景。
   */
  function disposeScene() {
    stopLoop();
    const { scene, composer, renderer } = STATE;
    if (scene) {
      scene.traverse((obj) => {
        if (obj.geometry && typeof obj.geometry.dispose === "function") obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => { if (m && typeof m.dispose === "function") m.dispose(); });
      });
      scene.clear();
    }
    if (composer) {
      (composer.passes || []).forEach((p) => { if (p && typeof p.dispose === "function") p.dispose(); });
      composer.dispose();
    }
    if (renderer) {
      renderer.dispose();
      if (typeof renderer.forceContextLoss === "function") renderer.forceContextLoss();
      const canvas = renderer.domElement;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
    STATE.renderer = null;
    STATE.composer = null;
    STATE.bloom = null;
    STATE.scene = null;
    STATE.camera = null;
    STATE.ribbons = [];
    STATE.glowSphere = null;
    STATE.loaded = false;
  }

  /**
   * 按 siri.orbGlow 归位辉光：外层菲涅尔球整颗隐藏，UnrealBloom 的强度与半径同步衰减。
   * 关掉后光带仍在流动，只是不再有那一圈漫射光晕 —— 这是设置项的真实视觉效果。
   * @returns {void}
   */
  function applyGlow() {
    const on = FLAGS.orbGlow !== false;
    if (STATE.glowSphere) STATE.glowSphere.visible = on;
    if (STATE.bloom) {
      STATE.bloom.strength = on ? BLOOM_STRENGTH : BLOOM_STRENGTH * 0.25;
      STATE.bloom.radius = on ? BLOOM_RADIUS : BLOOM_RADIUS * 0.4;
    }
  }

  /**
   * 唤醒提示音：声音本体与主音量归 kernel 的 sound.js 管，插件只决定「要不要响」。
   * 动态 import 而不是顶部 import：内核模块的路径不该在求值期就把插件绑上去。
   * @returns {void}
   */
  function playWake() {
    if (FLAGS.wakeSound === false) return;
    import("../../src/javascripts/sound.js")
      .then(({ sound }) => sound.playTone("alert"))
      .catch(() => { /* 声音模块缺席：光球照常打开 */ });
  }

  /**
   * 调整 Orb 尺寸（运行时实时生效，持久化走设置中枢的 siri.orb.size）。
   * 同时更新面板内联宽高、renderer 与 composer 渲染缓冲，使发光分辨率随尺寸变化。
   * @param {number} size 目标边长（px），会被钳制到 [ORB_SIZE_MIN, ORB_SIZE_MAX]
   */
  function applySize(size) {
    const v = Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, Math.round(size) || DEFAULT_ORB_SIZE));
    STATE.size = v;
    if (STATE.panelEl) {
      STATE.panelEl.style.width = v + "px";
      STATE.panelEl.style.height = v + "px";
    }
    if (STATE.renderer) STATE.renderer.setSize(v, v);
    if (STATE.composer) STATE.composer.setSize(v, v);
    const api = globalThis.__settings;
    if (api && typeof api.set === "function") {
      // 单一写入方：校验、落盘、广播都由设置中枢完成（它会补发 siri-orb-size-change，
      // 值未变化时不广播，因此回到本函数的 applySize 不会形成回环）
      api.set("siri.orb.size", v, { source: "siri" });
      return;
    }
    try { localStorage.setItem("siri-orb-size", String(v)); } catch (e) {}
  }

  /**
   * 系统设置「Siri」页拖动尺寸滑块的响应。
   * 仅在面板打开期间挂载（见 openSiri / closeSiri）：设置页同时会直接调用
   * window.__siri.setSize()，关闭态不需要这个监听，避免常驻。
   */
  function _onOrbSizeChange(e) {
    const v = parseInt(e.detail, 10);
    if (!isNaN(v)) applySize(v);
  }

  /** 打开 Siri 面板 */
  async function openSiri() {
    if (STATE.isOpen || STATE.isOpening || STATE.isClosing) return;
    STATE.isOpening = true;
    const session = STATE.session;

    // 上一次经 loader 打开时注入的 plugin-style-siri 会在卸载时被摘掉，这里补齐样式
    ensureStyle();
    const panel = ensurePanel();
    const canvas = panel.querySelector("canvas");

    try {
      if (!STATE.loaded) {
        await initThree(canvas); // 首次异步加载 three + 构建场景
      }
    } catch (err) {
      console.error("[siri] Three.js 加载/初始化失败", err);
      STATE.isOpening = false;
      return;
    }

    // 等待期间被卸载（STATE.session 已递增）：丢弃这次构建结果，不留孤儿 GPU 资源
    if (session !== STATE.session) {
      STATE.isOpening = false;
      disposeScene();
      return;
    }

    panel.classList.remove("closing");
    void panel.offsetWidth; // 强制 reflow 重启 transition
    panel.classList.add("visible");
    STATE.isOpen = true;
    STATE.isOpening = false;
    startLoop();
    applyGlow();
    playWake();
    window.__log?.info("plugin/siri", `光球已打开：边长 ${STATE.size}px，辉光${FLAGS.orbGlow ? "开" : "关"}，提示音${FLAGS.wakeSound ? "开" : "关"}`);

    window.addEventListener("siri-orb-size-change", _onOrbSizeChange);
    // 延迟一帧再挂「点击外部关闭」，避免本次打开用的那次点击立刻把它自己关掉
    STATE.bindFrame = requestAnimationFrame(() => {
      STATE.bindFrame = null;
      if (session !== STATE.session || !STATE.isOpen) return; // 期间已卸载/已关闭：不再挂载
      document.addEventListener("click", _onGlobalClick, true);
      document.addEventListener("keydown", _onEscKey, true);
    });
  }

  /** 释放本次会话的全部常驻资源：全局监听、关闭计时器、GPU、面板 DOM */
  function releaseSession() {
    if (STATE.closeTimer != null) {
      clearTimeout(STATE.closeTimer);
      STATE.closeTimer = null;
    }
    if (STATE.bindFrame != null) {
      cancelAnimationFrame(STATE.bindFrame);
      STATE.bindFrame = null;
    }
    stopLoop();
    document.removeEventListener("click", _onGlobalClick, true);
    document.removeEventListener("keydown", _onEscKey, true);
    window.removeEventListener("siri-orb-size-change", _onOrbSizeChange);
    STATE.session++; // 作废在途的 initThree
    disposeScene();
    if (STATE.panelEl && STATE.panelEl.isConnected) STATE.panelEl.remove();
    STATE.panelEl = null;
    // 自注入的样式表：plugin-manager 只回收 plugin-style-siri，siri-style 需自行摘除
    const style = document.getElementById("siri-style");
    if (style) style.remove();
    STATE.isOpen = false;
    STATE.isClosing = false;
    STATE.isOpening = false;
  }

  /** 关闭 Siri 面板 */
  function closeSiri() {
    if (!STATE.isOpen) return;
    if (STATE.isClosing) return;

    const panel = STATE.panelEl;
    if (!panel) return;

    STATE.isClosing = true;
    panel.classList.add("closing");
    stopLoop();

    document.removeEventListener("click", _onGlobalClick, true);
    document.removeEventListener("keydown", _onEscKey, true);
    window.removeEventListener("siri-orb-size-change", _onOrbSizeChange);

    STATE.closeTimer = setTimeout(() => {
      STATE.closeTimer = null;
      panel.classList.remove("visible", "closing");
      STATE.isOpen = false;
      STATE.isClosing = false;
    }, 280);
  }

  /** 切换开关 */
  function toggleSiri() {
    if (STATE.isOpen || STATE.isOpening) closeSiri();
    else openSiri();
  }

  /** 点击面板外部关闭 */
  function _onGlobalClick(e) {
    if (!STATE.panelEl) return;
    if (STATE.panelEl.contains(e.target)) return;
    closeSiri();
  }

  /** ESC 关闭 */
  function _onEscKey(e) {
    if (e.key === "Escape") closeSiri();
  }

  // 插件自有设置：注册即生效（apply 里改 FLAGS / 重画辉光），系统设置「插件」面板
  // 据此自动出两个开关，本插件不提供任何自绘设置界面。
  registerPluginSettings();

  // 对外暴露接口（与 launchpad 的 __launchpad 风格一致）
  window.__siri = {
    open: openSiri,
    close: closeSiri,
    toggle: toggleSiri,
    setSize: applySize,
    /** 由设置中枢驱动的开关当前值（只读，改它请走 __settings.set("siri.orbGlow", …)） */
    get orbGlow() { return FLAGS.orbGlow !== false; },
    get wakeSound() { return FLAGS.wakeSound !== false; },
    get size() { return STATE.size; },
    get isOpen() { return STATE.isOpen; },
  };

  // 资源释放：Siri 无窗口，卸载由 plugin-manager.unload("siri") 通知。
  // 该监听常驻不摘除：Siri 由顶栏图标长期持有（window.__siri 始终可用），
  // 摘掉后就再也收不到下一次卸载通知了；卸载后 STATE 已复位，下次打开重建场景与面板。
  const onSiriUnload = (e) => {
    if (e.detail.id !== "siri") return;
    releaseSession();
  };
  window.addEventListener("plugin-unload", onSiriUnload);

  console.log("[siri] 模块已加载（Three.js 版 Orb），接口: window.__siri.toggle()");
})();
