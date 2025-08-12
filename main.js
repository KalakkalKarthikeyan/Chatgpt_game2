/* main.js
   3D Maze — Find the Cat
   - Uses Three.js (ES module from unpkg)
   - PointerLockControls on desktop
   - Virtual joystick + action buttons on mobile
   - Drop into the same folder as index.html and style.css
*/

import * as THREE from 'https://unpkg.com/three@0.152.2/build/three.module.js';
import { PointerLockControls } from 'https://unpkg.com/three@0.152.2/examples/jsm/controls/PointerLockControls.js';

// ---------- DOM ----------
const container = document.getElementById('canvas-holder');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const difficultyEl = document.getElementById('difficulty');
const messageEl = document.getElementById('message');
const healthEl = document.getElementById('health');
const timeEl = document.getElementById('time');

const joystick = document.getElementById('joystick');
const joystickContainer = document.getElementById('joystick-container');
const lookLeftBtn = document.getElementById('lookLeft');
const lookRightBtn = document.getElementById('lookRight');
const jumpBtn = document.getElementById('jumpBtn');

// ---------- THREE.js basics ----------
let scene, camera, renderer, controls, clock;
let wallsGroup, objectsGroup;
let maze = [];
let mazeSize = 21;
const CELL = 4;            // world units per maze cell
let monsters = [];
let catPos = null;

let started = false;
let startTime = 0;
let lastTime = performance.now();

// player state
const player = {
  speed: 4,
  runMultiplier: 1.8,
  pos: new THREE.Vector3(),
  alive: true,
  velocityY: 0,
  onGround: true,
  radius: 0.4
};

// input state
const keys = {};
let mobileMove = { x: 0, y: 0 }; // joystick vector (-1..1)
let mobileLook = 0; // -1 left, +1 right
let mobileJump = false;

// ---------- Init ----------
function initThree(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x071827);

  camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  // lights
  const hemi = new THREE.HemisphereLight(0xbfeaff, 0x080820, 0.6);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xddeeff, 0.8);
  dir.position.set(10, 20, 10);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  scene.add(dir);

  // ground
  const groundGeo = new THREE.PlaneGeometry(500, 500);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x071827, metalness: 0.1, roughness: 0.9 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  wallsGroup = new THREE.Group(); wallsGroup.name = 'walls'; scene.add(wallsGroup);
  objectsGroup = new THREE.Group(); scene.add(objectsGroup);

  // controls
  controls = new PointerLockControls(camera, renderer.domElement);
  controls.getObject().position.set(0, 1.6, 0);
  scene.add(controls.getObject());

  clock = new THREE.Clock();

  // events
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('orientationchange', onWindowResize);

  // keyboard
  document.addEventListener('keydown', e => keys[e.code] = true);
  document.addEventListener('keyup', e => keys[e.code] = false);

  // pointer lock on click (desktop)
  renderer.domElement.addEventListener('click', () => {
    if (started && !controls.isLocked) controls.lock();
  });

  // click handlers to unlock message area etc
  controls.addEventListener('lock', () => {});
  controls.addEventListener('unlock', () => {});
}

function onWindowResize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ---------- Maze generation (recursive backtracker) ----------
function generateMaze(n) {
  // n odd
  maze = new Array(n).fill(0).map(() => new Array(n).fill(1)); // 1=wall,0=path
  function carve(x, y) {
    maze[y][x] = 0;
    const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2]].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx > 0 && ny > 0 && nx < n - 1 && ny < n - 1 && maze[ny][nx] === 1) {
        maze[y + dy / 2][x + dx / 2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);
  maze[1][0] = 0; maze[n - 2][n - 1] = 0;
  return maze;
}

// ---------- Build maze meshes ----------
function buildMazeMesh() {
  // cleanup
  wallsGroup.clear(); objectsGroup.clear();
  monsters.forEach(m => scene.remove(m.mesh)); monsters = [];

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0f1724, metalness: 0.2, roughness: 0.7 });
  const wallGeo = new THREE.BoxGeometry(CELL, 3, CELL);

  for (let y = 0; y < mazeSize; y++) for (let x = 0; x < mazeSize; x++) {
    if (maze[y][x] === 1) {
      const mx = (x - mazeSize / 2) * CELL + CELL / 2;
      const mz = (y - mazeSize / 2) * CELL + CELL / 2;
      const box = new THREE.Mesh(wallGeo, wallMat);
      box.position.set(mx, 1.5, mz);
      box.castShadow = true; box.receiveShadow = true;
      wallsGroup.add(box);
    }
  }

  // player start at (1,1)
  const startX = (1 - mazeSize / 2) * CELL + CELL / 2;
  const startZ = (1 - mazeSize / 2) * CELL + CELL / 2;
  controls.getObject().position.set(startX, 1.6, startZ);
  player.pos.set(startX, 1.6, startZ);

  // place cat near far corner (search last path cell)
  catPos = null;
  for (let y = mazeSize - 2; y > 0 && !catPos; y--) {
    for (let x = mazeSize - 2; x > 0 && !catPos; x--) {
      if (maze[y][x] === 0) {
        const cx = (x - mazeSize / 2) * CELL + CELL / 2;
        const cz = (y - mazeSize / 2) * CELL + CELL / 2;
        placeCat(cx, cz);
        catPos = new THREE.Vector3(cx, 1.2, cz);
      }
    }
  }

  // monster spawn candidates (dead-ends)
  const monsterCount = difficultyEl.value === 'easy' ? 3 : (difficultyEl.value === 'medium' ? 7 : 15);
  const candidates = [];
  for (let y = 1; y < mazeSize - 1; y++) for (let x = 1; x < mazeSize - 1; x++) if (maze[y][x] === 0) {
    let adj = 0; [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { if (maze[y + dy][x + dx] === 0) adj++; });
    if (adj <= 2) candidates.push({ x, y });
  }
  for (let i = 0; i < monsterCount && candidates.length; i++) {
    const idx = Math.floor(Math.random() * candidates.length);
    const { x, y } = candidates.splice(idx, 1)[0];
    const mx = (x - mazeSize / 2) * CELL + CELL / 2;
    const mz = (y - mazeSize / 2) * CELL + CELL / 2;
    spawnMonster(mx, mz);
  }

  // ambient pillars
  const pillarGeo = new THREE.CylinderGeometry(0.6, 0.6, 2.5, 12);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x0b6b6b, metalness: 0.4, roughness: 0.6 });
  for (let i = 0; i < 10; i++) {
    const px = (Math.random() * mazeSize - mazeSize / 2) * CELL;
    const pz = (Math.random() * mazeSize - mazeSize / 2) * CELL;
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(px, 1.25, pz);
    pillar.scale.setScalar(0.6 + Math.random() * 0.8);
    objectsGroup.add(pillar);
  }
}

function placeCat(x, z) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.8), new THREE.MeshStandardMaterial({ color: 0xffc24d, metalness: 0.2, roughness: 0.6 }));
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0xffd37a }));
  head.position.set(0, 0.6, 0.4);
  const earGeom = new THREE.BoxGeometry(0.18, 0.2, 0.12);
  const ear1 = new THREE.Mesh(earGeom, head.material); ear1.position.set(-0.18, 0.96, 0.6);
  const ear2 = ear1.clone(); ear2.position.set(0.18, 0.96, 0.6);
  g.add(body, head, ear1, ear2);
  g.position.set(x, 0.6, z);
  g.name = 'cat';
  objectsGroup.add(g);
}

function spawnMonster(x, z) {
  const m = {
    mesh: null,
    origin: new THREE.Vector3(x, 0.6, z),
    pos: new THREE.Vector3(x, 0.6, z),
    dir: Math.random() * Math.PI * 2,
    speed: 1 + Math.random() * 1.5
  };
  const geo = new THREE.SphereGeometry(0.5, 16, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff5b5b, emissive: 0x2a0000, metalness: 0.2, roughness: 0.6 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.position.copy(m.pos);
  m.mesh = mesh;
  monsters.push(m);
  scene.add(mesh);
}

// ---------- Game control ----------
function startGame() {
  // set maze size by difficulty
  const diff = difficultyEl.value;
  if (diff === 'easy') mazeSize = 11; else if (diff === 'medium') mazeSize = 21; else mazeSize = 31;
  if (mazeSize % 2 === 0) mazeSize++;

  generateMaze(mazeSize);
  buildMazeMesh();
  startTime = performance.now();
  started = true; player.alive = true;
  healthEl.textContent = '100'; timeEl.textContent = '0';
  // lock pointer on start for desktop
  try { controls.lock(); } catch (e) {}
  messageEl.style.display = 'none';
}

function resetGame() {
  started = false;
  messageEl.style.display = 'none';
  wallsGroup.clear(); objectsGroup.clear();
  monsters.forEach(m => scene.remove(m.mesh)); monsters = [];
  controls.getObject().position.set(0, 50, 0);
}

// ---------- Collision (simple AABB checks against wall boxes) ----------
function checkWallCollision(pos) {
  // pos is Vector3 (player center)
  const px = pos.x, pz = pos.z;
  for (const w of wallsGroup.children) {
    const b = new THREE.Box3().setFromObject(w);
    // shrink box slightly so player can slide
    b.expandByScalar(-0.6);
    if (px > b.min.x && px < b.max.x && pz > b.min.z && pz < b.max.z) return true;
  }
  return false;
}

// ---------- Update loop ----------
function update(delta) {
  if (!started) return;

  // Determine move vector
  let forward = 0, strafe = 0;
  // desktop keys
  forward += (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  strafe += (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);

  // mobile joystick overrides/adds
  // joystick y: negative = forward (screen coord), x: positive = right
  if (mobileMove.y !== 0 || mobileMove.x !== 0) {
    forward += -mobileMove.y;
    strafe += mobileMove.x;
  }

  // run modifier
  let speed = player.speed * ((keys['ShiftLeft'] || keys['ShiftRight']) ? player.runMultiplier : 1);

  // compute direction from camera yaw (flat direction)
  const dir = new THREE.Vector3();
  controls.getDirection(dir); dir.y = 0; dir.normalize();
  const right = new THREE.Vector3(); right.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();

  const move = new THREE.Vector3();
  move.addScaledVector(dir, forward);
  move.addScaledVector(right, strafe);
  if (move.length() > 0) move.normalize().multiplyScalar(speed * delta);

  // resp for desktop when pointer not locked (no movement)
  if (!controls.isLocked && !(mobileMove.x || mobileMove.y)) {
    // don't move if desktop pointer unlocked and no mobile input
    move.set(0, 0, 0);
  }

  // attempt move with collision
  const nextPos = controls.getObject().position.clone().add(move);
  nextPos.y = controls.getObject().position.y; // keep current y (vertical handled separately)

  if (!checkWallCollision(nextPos)) {
    controls.getObject().position.copy(nextPos);
    player.pos.copy(nextPos);
  } else {
    // Try sliding: move only x or z separately
    const attemptX = controls.getObject().position.clone().add(new THREE.Vector3(move.x, 0, 0));
    attemptX.y = controls.getObject().position.y;
    if (!checkWallCollision(attemptX)) {
      controls.getObject().position.copy(attemptX); player.pos.copy(attemptX);
    } else {
      const attemptZ = controls.getObject().position.clone().add(new THREE.Vector3(0, 0, move.z));
      attemptZ.y = controls.getObject().position.y;
      if (!checkWallCollision(attemptZ)) {
        controls.getObject().position.copy(attemptZ); player.pos.copy(attemptZ);
      }
    }
  }

  // Mobile look buttons rotate the camera yaw
  if (mobileLook !== 0) {
    const yawSpeed = 1.6; // radians/sec
    controls.getObject().rotation.y -= mobileLook * yawSpeed * delta;
  }
  // keyboard look (ArrowLeft/ArrowRight)
  if (keys['ArrowLeft']) controls.getObject().rotation.y += 1.6 * delta;
  if (keys['ArrowRight']) controls.getObject().rotation.y -= 1.6 * delta;

  // Jumping / gravity
  const GRAVITY = -12;
  const JUMP_SPEED = 6;
  // detect ground by simple raycast or y threshold: here assume y=1.6 is ground level in maze
  if (player.onGround && (keys['Space'] || mobileJump)) {
    player.velocityY = JUMP_SPEED;
    player.onGround = false;
    mobileJump = false; // consume mobile jump
  }
  // integrate velocity
  player.velocityY += GRAVITY * delta;
  let newY = controls.getObject().position.y + player.velocityY * delta;
  if (newY <= 1.6) {
    newY = 1.6; player.velocityY = 0; player.onGround = true;
  }
  controls.getObject().position.y = newY;

  // Monsters behavior & collisions
  for (const m of monsters) {
    const mv = new THREE.Vector3(Math.cos(m.dir), 0, Math.sin(m.dir)).multiplyScalar(m.speed * delta);
    const attempt = m.pos.clone().add(mv);
    if (checkWallCollision(attempt) || Math.random() < 0.01) {
      m.dir += (Math.random() - 0.5) * Math.PI;
    } else {
      m.pos.copy(attempt);
      m.mesh.position.copy(m.pos);
    }

    // collision with player
    const dist = m.pos.distanceTo(player.pos);
    if (dist < 1.0 && player.alive) {
      player.alive = false;
      showMessage('You Died — A monster got you', false);
    }
  }

  // Check cat found
  if (catPos && player.pos.distanceTo(catPos) < 1.2 && started) {
    showMessage('You Found the Cat! You Win 🎉', true);
    started = false;
  }

  // time display
  const secs = Math.floor((performance.now() - startTime) / 1000);
  timeEl.textContent = secs;
}

// ---------- UI helpers ----------
function showMessage(txt, win) {
  messageEl.style.display = 'block';
  messageEl.textContent = txt;
  messageEl.style.background = win ? 'linear-gradient(90deg,#4ade80,#10b981)' : 'linear-gradient(90deg,#ff6b6b,#ff3b3b)';
  try { controls.unlock(); } catch (e) {}
}

// ---------- Animation ----------
function animate() {
  const now = performance.now();
  const delta = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  requestAnimationFrame(animate);
  update(delta);
  renderer.render(scene, camera);
}

// ---------- Mobile joystick implementation ----------
(function setupJoystick(){
  // Basic virtual joystick that sets mobileMove.x and mobileMove.y in [-1,1]
  let active = false;
  let startX = 0, startY = 0;
  const maxRadius = 50; // px thumb travel radius

  function toLocal(e) {
    const rect = joystickContainer.getBoundingClientRect();
    return { x: (e.touches ? e.touches[0].clientX : e.clientX) - rect.left, y: (e.touches ? e.touches[0].clientY : e.clientY) - rect.top };
  }

  joystickContainer.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    active = true;
    const rect = joystickContainer.getBoundingClientRect();
    // place joystick center where touch happened
    startX = (ev.touches[0].clientX - rect.left);
    startY = (ev.touches[0].clientY - rect.top);
    joystick.style.transform = `translate(${startX - 28}px, ${startY - 28}px)`; // center-ish
    joystick.style.opacity = '1';
  }, { passive: false });

  joystickContainer.addEventListener('touchmove', (ev) => {
    if (!active) return;
    ev.preventDefault();
    const rect = joystickContainer.getBoundingClientRect();
    const tx = ev.touches[0].clientX - rect.left;
    const ty = ev.touches[0].clientY - rect.top;
    let dx = tx - startX, dy = ty - startY;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) { dx = dx / dist * maxRadius; dy = dy / dist * maxRadius; }
    joystick.style.transform = `translate(${startX + dx - 28}px, ${startY + dy - 28}px)`;
    // normalized: forward is -y in joystick coords
    mobileMove.x = dx / maxRadius;
    mobileMove.y = dy / maxRadius;
    // invert y so pushing up -> forward
    mobileMove.y = -mobileMove.y;
  }, { passive: false });

  function endTouch() {
    active = false;
    joystick.style.opacity = '0.25';
    // reset position to center
    joystick.style.transform = '';
    mobileMove.x = 0; mobileMove.y = 0;
  }
  joystickContainer.addEventListener('touchend', endTouch);
  joystickContainer.addEventListener('touchcancel', endTouch);

  // Also support mouse for testing on desktop
  joystickContainer.addEventListener('mousedown', (ev) => {
    active = true;
    const rect = joystickContainer.getBoundingClientRect();
    startX = ev.clientX - rect.left; startY = ev.clientY - rect.top;
    joystick.style.transform = `translate(${startX - 28}px, ${startY - 28}px)`; joystick.style.opacity = '1';
    function mm(e) {
      const tx = e.clientX - rect.left, ty = e.clientY - rect.top;
      let dx = tx - startX, dy = ty - startY;
      const dist = Math.hypot(dx, dy);
      if (dist > maxRadius) { dx = dx / dist * maxRadius; dy = dy / dist * maxRadius; }
      joystick.style.transform = `translate(${startX + dx - 28}px, ${startY + dy - 28}px)`;
      mobileMove.x = dx / maxRadius; mobileMove.y = - (dy / maxRadius);
    }
    function up() { active = false; joystick.style.opacity = '0.25'; joystick.style.transform = ''; mobileMove.x = 0; mobileMove.y = 0; window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', mm); window.addEventListener('mouseup', up);
  });
})();

// ---------- Mobile action buttons ----------
lookLeftBtn && lookLeftBtn.addEventListener('touchstart', (e) => { e.preventDefault(); mobileLook = -1; }, { passive: false });
lookLeftBtn && lookLeftBtn.addEventListener('touchend', (e) => { mobileLook = 0; }, { passive: false });

lookRightBtn && lookRightBtn.addEventListener('touchstart', (e) => { e.preventDefault(); mobileLook = +1; }, { passive: false });
lookRightBtn && lookRightBtn.addEventListener('touchend', (e) => { mobileLook = 0; }, { passive: false });

jumpBtn && jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); mobileJump = true; }, { passive: false });
jumpBtn && jumpBtn.addEventListener('touchend', (e) => { /* mobileJump consumed in update */ }, { passive: false });

// also support mouse clicks for buttons (desktop testing)
lookLeftBtn && lookLeftBtn.addEventListener('mousedown', () => mobileLook = -1);
lookLeftBtn && lookLeftBtn.addEventListener('mouseup', () => mobileLook = 0);
lookRightBtn && lookRightBtn.addEventListener('mousedown', () => mobileLook = +1);
lookRightBtn && lookRightBtn.addEventListener('mouseup', () => mobileLook = 0);
jumpBtn && jumpBtn.addEventListener('mousedown', () => mobileJump = true);
jumpBtn && jumpBtn.addEventListener('mouseup', () => mobileJump = false);

// ---------- Hook UI ----------
startBtn.addEventListener('click', () => startGame());
resetBtn.addEventListener('click', () => resetGame());

// pointer lock helpful hint: unlock to show overlay again
controls && controls.addEventListener && controls.addEventListener('unlock', () => {
  // nothing special now
});

// ---------- Start everything ----------
initThree();
animate();

// position camera up when not started
controls.getObject().position.set(0, 50, 0);

// console help
console.log('3D Maze loaded. Click Start. On mobile use the joystick and action buttons.');
