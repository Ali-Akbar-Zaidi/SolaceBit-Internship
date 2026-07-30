/**
 * SiteSage 3D background + depth interactions.
 *
 * - Three.js particle nebula (BufferGeometry + Points, ~1800 particles:
 *   safe mobile baseline per three.js guidelines) in brand violet/cyan.
 * - Wireframe icosahedron "knowledge core" slowly rotating with a glow halo.
 * - Pointer parallax: camera eases toward the cursor for depth.
 * - 3D tilt on the URL panel (CSS transforms, GPU-only properties).
 * - Respects prefers-reduced-motion (renders one static frame, no tilt),
 *   pauses when the tab is hidden, caps devicePixelRatio at 1.5 for iGPUs.
 * - If WebGL or the CDN fails, the CSS ambient orbs remain as fallback.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
(async () => {
    let THREE;
    try {
        THREE = await import("https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js");
    } catch {
        return; // offline or CDN blocked: CSS orbs keep the page alive
    }

    const canvas = document.getElementById("bg3d");
    if (!canvas) return;

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
        return; // no WebGL: fall back to CSS background
    }

    renderer.setClearColor(0x000000, 0); // transparent - CSS owns the base color
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050506, 0.055);

    const camera = new THREE.PerspectiveCamera(
        60, window.innerWidth / window.innerHeight, 0.1, 100
    );
    camera.position.set(0, 0, 9);

    // --- Particle nebula (single draw call) ---------------------------------
    const COUNT = 1800;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const violet = new THREE.Color(0x7c3aed);
    const indigo = new THREE.Color(0x5b6bf5);
    const cyan = new THREE.Color(0x22d3ee);

    for (let i = 0; i < COUNT; i++) {
        // Scatter inside a flattened ellipsoid so particles hug the screen.
        const r = 6 + Math.random() * 14;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta) * 1.6;
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.9;
        positions[i * 3 + 2] = r * Math.cos(phi) * 0.8 - 4;

        const t = Math.random();
        const color = t < 0.5 ? violet.clone().lerp(indigo, t * 2) : indigo.clone().lerp(cyan, (t - 0.5) * 2);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Soft round sprite so points glow instead of rendering as squares.
    const spriteCanvas = document.createElement("canvas");
    spriteCanvas.width = spriteCanvas.height = 64;
    const ctx = spriteCanvas.getContext("2d");
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(spriteCanvas);

    const particles = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
            size: 0.16,
            map: sprite,
            vertexColors: true,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        })
    );
    scene.add(particles);

    // --- Wireframe "knowledge core" -----------------------------------------
    const core = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.6, 1)),
        new THREE.LineBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.14 })
    );
    core.position.set(4.2, 1.4, -3);
    scene.add(core);

    const coreInner = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.5, 0)),
        new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.12 })
    );
    coreInner.position.copy(core.position);
    scene.add(coreInner);

    // Glow halo behind the core (sprite, additive).
    const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: sprite,
            color: 0x7c3aed,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        })
    );
    halo.scale.set(9, 9, 1);
    halo.position.copy(core.position);
    scene.add(halo);

    // --- Pointer parallax -----------------------------------------------------
    const target = { x: 0, y: 0 };
    if (!reducedMotion) {
        window.addEventListener("pointermove", (e) => {
            target.x = (e.clientX / window.innerWidth - 0.5) * 2;
            target.y = (e.clientY / window.innerHeight - 0.5) * 2;
        }, { passive: true });
    }

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- Render loop ----------------------------------------------------------
    let running = true;
    document.addEventListener("visibilitychange", () => {
        running = !document.hidden;
        if (running && !reducedMotion) requestAnimationFrame(tick);
    });

    const clock = new THREE.Clock();

    function render() {
        const t = clock.getElapsedTime();

        particles.rotation.y = t * 0.02;
        particles.rotation.x = Math.sin(t * 0.05) * 0.04;

        core.rotation.y = t * 0.12;
        core.rotation.x = t * 0.05;
        coreInner.rotation.y = -t * 0.18;
        coreInner.rotation.z = t * 0.07;

        halo.material.opacity = 0.18 + Math.sin(t * 0.8) * 0.06;

        // Ease the camera toward the pointer for parallax depth.
        camera.position.x += (target.x * 0.9 - camera.position.x) * 0.03;
        camera.position.y += (-target.y * 0.6 - camera.position.y) * 0.03;
        camera.lookAt(0, 0, -2);

        renderer.render(scene, camera);
    }

    function tick() {
        if (!running) return;
        render();
        requestAnimationFrame(tick);
    }

    if (reducedMotion) {
        render(); // one static, composed frame - no motion
    } else {
        requestAnimationFrame(tick);
    }
})();

// Panel tilt / spotlight / aurora parallax live in app.js (CSS-variable
// based) - this module only owns the WebGL layer.
