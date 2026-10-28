// ---------------------------------------------------------------------------
// 场景：渲染器 / 天空 / 地面 / 光照 / 环境反射 / 泛光后处理
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const PALETTE = {
  cyan: 0x3fe0ff, amber: 0xffb04a, green: 0x5cf2a6, red: 0xff6b7a,
  violet: 0xa98bff, carbon: 0x1b2129, steel: 0x8fa3b8,
};

// 程序化环境贴图（渐变天空 + 太阳），供 PBR 反射使用
function makeEnvTexture() {
  const w = 512, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#0a1424');
  grad.addColorStop(0.42, '#16283c');
  grad.addColorStop(0.52, '#3a4a5c');
  grad.addColorStop(0.58, '#1a222c');
  grad.addColorStop(1.0, '#05070b');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // 太阳
  const sun = g.createRadialGradient(w * 0.72, h * 0.30, 0, w * 0.72, h * 0.30, h * 0.5);
  sun.addColorStop(0, 'rgba(255,238,205,1)');
  sun.addColorStop(0.08, 'rgba(255,206,140,0.75)');
  sun.addColorStop(0.35, 'rgba(255,170,90,0.16)');
  sun.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = sun; g.fillRect(0, 0, w, h);
  // 冷色补光
  const fill = g.createRadialGradient(w * 0.2, h * 0.55, 0, w * 0.2, h * 0.55, h * 0.6);
  fill.addColorStop(0, 'rgba(70,150,210,0.30)');
  fill.addColorStop(1, 'rgba(40,90,140,0)');
  g.fillStyle = fill; g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const skyVert = `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const skyFrag = `
varying vec3 vDir;
uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uHorizon; uniform vec3 uSun;
void main(){
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uBottom, uHorizon, smoothstep(0.34, 0.52, h));
  col = mix(col, uTop, smoothstep(0.5, 1.0, h));
  float d = max(dot(normalize(vDir), normalize(uSun)), 0.0);
  col += vec3(1.0, 0.72, 0.42) * pow(d, 220.0) * 1.6;
  col += vec3(1.0, 0.62, 0.34) * pow(d, 8.0) * 0.10;
  gl_FragColor = vec4(col, 1.0);
}`;

const groundVert = `
varying vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const groundFrag = `
varying vec3 vWorld;
uniform vec3 uGrid; uniform vec3 uBase; uniform vec3 uCam;
float gridLine(vec2 p, float stepSize, float thickness){
  vec2 g = abs(fract(p / stepSize - 0.5) - 0.5) / (thickness / stepSize);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main(){
  float r = length(vWorld.xz);
  float fade = 1.0 - smoothstep(6.0, 42.0, r);
  float g1 = gridLine(vWorld.xz, 0.5, 0.012) * 0.55;
  float g2 = gridLine(vWorld.xz, 2.5, 0.045) * 0.85;
  vec3 col = uBase;
  col += uGrid * (g1 + g2) * fade;
  // 中心台面光晕
  col += vec3(0.10, 0.34, 0.46) * exp(-r * 0.10) * 0.30;
  col *= 0.55 + 0.45 * fade;
  float alpha = clamp(0.28 + fade * 0.72, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

export function createViewport(canvas) {
  const LITE = /[?&]lite=1/.test(location.search);
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: !LITE, alpha: false, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(LITE ? 1 : Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a1420, 0.021);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.03, 220);
  camera.position.set(1.22, 1.86, 1.40);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 0.28;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 1.7, 0);

  // ---- 环境反射 ----
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = makeEnvTexture();
  scene.environment = pmrem.fromEquirectangular(envTex).texture;
  scene.environmentIntensity = 0.85;

  // ---- 天空 ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x050a14) },
        uBottom: { value: new THREE.Color(0x05080d) },
        uHorizon: { value: new THREE.Color(0x2a3a4c) },
        uSun: { value: new THREE.Vector3(0.62, 0.30, 0.72) },
      },
    })
  );
  scene.add(sky);

  // ---- 地面 ----
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160, 1, 1),
    new THREE.ShaderMaterial({
      vertexShader: groundVert, fragmentShader: groundFrag,
      transparent: true, depthWrite: true,
      uniforms: {
        uGrid: { value: new THREE.Color(0x2f6f8c) },
        uBase: { value: new THREE.Color(0x080c12) },
        uCam: { value: new THREE.Vector3() },
      },
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  // 发光起降圈
  const padTex = (() => {
    const s = 256, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(63,224,255,0.85)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1.4;
    g.strokeStyle = 'rgba(63,224,255,0.35)';
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r0 = s * 0.47, r1 = s * (i % 3 === 0 ? 0.5 : 0.48);
      g.strokeStyle = i % 3 === 0 ? 'rgba(63,224,255,0.9)' : 'rgba(63,224,255,0.35)';
      g.lineWidth = i % 3 === 0 ? 2.2 : 1.1;
      g.beginPath();
      g.moveTo(s / 2 + Math.cos(a) * r0, s / 2 + Math.sin(a) * r0);
      g.lineTo(s / 2 + Math.cos(a) * r1, s / 2 + Math.sin(a) * r1);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({ map: padTex, transparent: true, opacity: 0.5, depthWrite: false })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.004;
  scene.add(pad);

  // ---- 光照 ----
  const hemi = new THREE.HemisphereLight(0x3a5876, 0x0a0e14, 0.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0dc, 1.75);
  sun.position.set(4.2, 6.4, 3.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(LITE ? 1024 : 2048, LITE ? 1024 : 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 22;
  const sc = sun.shadow.camera;
  sc.left = -2.2; sc.right = 2.2; sc.top = 2.2; sc.bottom = -2.2;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  const rim = new THREE.DirectionalLight(0x6cc6ff, 1.25);
  rim.position.set(-4.0, 2.6, -4.2);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x96b6d8, 0.55);
  fill.position.set(-1.5, -2.0, 2.5);
  scene.add(fill);

  const under = new THREE.PointLight(0x3fe0ff, 16, 6, 2);
  under.position.set(0, 0.05, 0);
  scene.add(under);

  const bob = new THREE.PointLight(0xffb04a, 3.5, 3.2, 2);
  bob.position.set(0.2, 1.4, 0.2);
  scene.add(bob);

  // ---- 后处理 ----
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.30, 0.62, 0.94);
  composer.addPass(bloom);
  if (LITE) bloom.enabled = false;
  composer.addPass(new OutputPass());

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  }
  addEventListener('resize', resize);

  return { renderer, scene, camera, controls, composer, bloom, sun, hemi, pad, ground, sky, resize, lite: LITE };
}
