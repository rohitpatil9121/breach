import { TouchControls } from "../engine/index.js";
import { BTN, WEAPONS } from "./data.js";

/**
 * BREACH: the player's controls. Keyboard and mouse first, then gamepad, then touch, all ending up as
 * the same thing: one small input per tick (see game/sim.js PlayerInput) and a view direction.
 *
 * Every action can be rebound. A binding is a list of codes the engine's Input understands: a
 * KeyboardEvent.code ("KeyW"), a mouse button ("Mouse0"), a gamepad button ("GamepadA") or an on-screen
 * touch button ("TouchFire"). Rebinding replaces the keyboard-and-mouse codes of an action, or its
 * gamepad code, depending on what was pressed, and leaves the other device's alone.
 * @module game/controls
 */

export const ACTIONS = [
    { id: "forward", label: "Move forward", codes: ["KeyW", "ArrowUp"] },
    { id: "back", label: "Move back", codes: ["KeyS", "ArrowDown"] },
    { id: "left", label: "Move left", codes: ["KeyA", "ArrowLeft"] },
    { id: "right", label: "Move right", codes: ["KeyD", "ArrowRight"] },
    { id: "jump", label: "Jump", codes: ["Space", "GamepadA", "TouchJump"] },
    { id: "sprint", label: "Sprint", codes: ["ShiftLeft", "GamepadLS"] },
    { id: "crouch", label: "Crouch", codes: ["KeyC", "GamepadB", "TouchCrouch"] },
    { id: "fire", label: "Fire", codes: ["Mouse0", "GamepadRT", "TouchFire"] },
    { id: "zoom", label: "Zoom (rifle)", codes: ["Mouse2", "GamepadLT", "TouchZoom"] },
    { id: "next", label: "Next weapon", codes: ["KeyE", "GamepadRB", "TouchNext"] },
    { id: "prev", label: "Previous weapon", codes: ["KeyQ", "GamepadLB"] },
    ...WEAPONS.map((w, i) => ({ id: "weapon" + (i + 1), label: w.name, codes: ["Digit" + (i + 1)] })),
    { id: "scores", label: "Scores", codes: ["Tab", "GamepadBack"] },
    { id: "chat", label: "Chat", codes: ["Enter"] },
];
export const defaultBindings = () => Object.fromEntries(ACTIONS.map((a) => [a.id, a.codes.slice()]));

const isPad = (code) => code.startsWith("Gamepad"), isTouch = (code) => code.startsWith("Touch");
const NAMES = { Mouse0: "Left mouse", Mouse1: "Middle mouse", Mouse2: "Right mouse", Space: "Space", ShiftLeft: "Left Shift", ShiftRight: "Right Shift", ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
    AltLeft: "Left Alt", AltRight: "Right Alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Enter", Tab: "Tab", Backquote: "`", Minus: "-", Equal: "=" };
/** A code as a person would say it. */
export function codeName(code) {
    if (NAMES[code]) return NAMES[code];
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return "Num " + code.slice(6);
    if (isPad(code)) return "Pad " + code.slice(7);
    return code;
}
/** The keyboard-or-mouse part and the gamepad part of a binding, for showing in the settings. */
export function describe(codes) {
    return { keys: codes.filter((c) => !isPad(c) && !isTouch(c)).map(codeName).join(" or ") || "none", pad: codes.filter(isPad).map(codeName).join(" or ") || "none" };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Controls {
    /**
     * @param {import("../engine/Input.js").Input} input
     * @param {HTMLCanvasElement} canvas
     * @param {{ sensitivity: number, invertY: boolean, bindings: Record<string, string[]> }} settings read live, so changes apply at once
     */
    constructor(input, canvas, settings) {
        this.input = input;
        this.canvas = canvas;
        this.settings = settings;
        /** where the player is looking, in radians; `kick` is the recoil shown on top of it */
        this.view = { yaw: 0, pitch: 0, kick: 0 };
        /** 1 = full field of view; smaller while zoomed, so the mouse slows in proportion */
        this.zoomScale = 1;
        /** only look and act while the match has the player's attention */
        this.active = false;
        this.wheel = 0;
        this.coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
        this.apply();

        // the mouse turns the view as events arrive, not once per tick
        document.addEventListener("mousemove", (e) => {
            if (!this.active || !input.pointer.locked) return;
            this.turn(-e.movementX * 0.0022, -e.movementY * 0.0022);
        });

        // While the mouse is captured its buttons are read here. The engine's Input takes them from pointer
        // events and asks for pointer capture first, which a browser refuses on an element that holds the
        // pointer lock; the refusal stops that handler before the press is recorded.
        // (so that handler is kept from running at all while locked: the same refusal would otherwise fill the console)
        canvas.addEventListener("pointerdown", (e) => { if (input.pointer.locked) e.stopImmediatePropagation(); }, true);
        document.addEventListener("mousedown", (e) => { if (input.pointer.locked) { input.press("Mouse" + e.button); e.preventDefault(); } });
        document.addEventListener("mouseup", (e) => input.release("Mouse" + e.button));

        // touch: a stick on the left, buttons on the right, and a drag anywhere else on the right to look
        this.touch = new TouchControls(input, { visible: false });
        this.touch.joystick({ x: "moveX", y: "moveY" });
        this.touch.button({ code: "TouchFire", label: "Fire", size: 84, offset: [24, 30] });
        this.touch.button({ code: "TouchJump", label: "Jump", size: 60, offset: [122, 24] });
        this.touch.button({ code: "TouchCrouch", label: "Duck", size: 56, offset: [30, 128] });
        this.touch.button({ code: "TouchZoom", label: "Zoom", size: 56, offset: [100, 108] });
        this.touch.button({ code: "TouchNext", label: "Gun", size: 56, offset: [170, 84] });
        const drags = new Map();
        canvas.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") drags.set(e.pointerId, [e.clientX, e.clientY]); });
        canvas.addEventListener("pointermove", (e) => {
            const from = drags.get(e.pointerId);
            if (!from || !this.active) return;
            this.turn(-(e.clientX - from[0]) * 0.006, -(e.clientY - from[1]) * 0.006);
            from[0] = e.clientX; from[1] = e.clientY;
        });
        for (const type of ["pointerup", "pointercancel"]) canvas.addEventListener(type, (e) => drags.delete(e.pointerId));
    }

    /** Turn the view by an angle (already scaled for the device); sensitivity, zoom and inversion are applied here. */
    turn(dYaw, dPitch) {
        const s = this.settings.sensitivity * this.zoomScale, v = this.view;
        v.yaw += dYaw * s;
        v.pitch = clamp(v.pitch + dPitch * s * (this.settings.invertY ? -1 : 1), -1.5, 1.5);
    }

    /** Hand the bindings to the engine's Input. Call after any change. */
    apply() {
        const b = this.settings.bindings, input = this.input, keys = (id) => b[id] || [];
        input.bindAxis("moveX", { negative: keys("left"), positive: keys("right"), gamepad: "LeftX" });
        input.bindAxis("moveY", { negative: keys("back"), positive: keys("forward") });
        for (const a of ACTIONS) if (!["forward", "back", "left", "right"].includes(a.id)) input.bind(a.id, keys(a.id));
        input.bind("pause", ["GamepadStart"]);
    }

    /** Show or hide the on-screen controls (they are for touch screens, and only during a match). */
    showTouch(on) { this.touch.setVisible(on && this.coarse); }

    /**
     * Wait for the next key, mouse button or gamepad button and make it the binding for an action.
     * Escape cancels. Resolves to the code, or null.
     */
    capture(actionId) {
        return new Promise((done) => {
            const finish = (code) => {
                removeEventListener("keydown", onKey, true); removeEventListener("mousedown", onMouse, true); clearInterval(poll);
                if (code) {
                    const codes = this.settings.bindings[actionId] || [];
                    this.settings.bindings[actionId] = isPad(code) ? [...codes.filter((c) => !isPad(c)), code] : [code, ...codes.filter((c) => isPad(c) || isTouch(c))];
                    this.apply();
                }
                done(code);
            };
            const onKey = (e) => { e.preventDefault(); e.stopPropagation(); finish(e.code === "Escape" ? null : e.code); };
            const onMouse = (e) => { e.preventDefault(); e.stopPropagation(); finish("Mouse" + e.button); };
            // a gamepad has no events for buttons: look a few times a second
            const names = ["GamepadA", "GamepadB", "GamepadX", "GamepadY", "GamepadLB", "GamepadRB", "GamepadLT", "GamepadRT", "GamepadBack", "GamepadStart", "GamepadLS", "GamepadRS", "GamepadUp", "GamepadDown", "GamepadLeft", "GamepadRight"];
            const poll = setInterval(() => {
                for (const pad of navigator.getGamepads ? navigator.getGamepads() : []) if (pad) for (let i = 0; i < names.length; i++) if (pad.buttons[i] && pad.buttons[i].pressed) return finish(names[i]);
            }, 60);
            addEventListener("keydown", onKey, true);
            // let the click that started the capture finish before listening for the next one
            setTimeout(() => addEventListener("mousedown", onMouse, true), 150);
        });
    }

    /** Is an action held? A finger on the view is for looking, so it doesn't count as the mouse button. */
    held(action) {
        const input = this.input;
        if (input.pointer.type !== "touch") return input.isDown(action);
        for (const code of this.settings.bindings[action] || []) if (!code.startsWith("Mouse") && input.down.has(code)) return true;
        return false;
    }

    /** The right stick turns the view. Call once per rendered frame. */
    look(dt) {
        if (!this.active) return;
        const x = this.input.stick("RightX"), y = this.input.stick("RightY");
        // a curve, so small pushes aim finely and a full push turns fast
        if (x || y) this.turn(-x * Math.abs(x) * 3.4 * dt, -y * Math.abs(y) * 2.4 * dt);
    }

    /**
     * This tick's controls. Call once per fixed step.
     * @param {object} me the local player, to know which weapons can be cycled to
     * @returns {{ mx: number, my: number, buttons: number, weapon: number }}
     */
    gather(me) {
        const input = this.input, out = { mx: 0, my: 0, buttons: 0, weapon: 0 };
        if (!this.active) { this.wheel = 0; return out; }
        if (this.held("jump")) out.buttons |= BTN.jump;
        if (this.held("sprint")) out.buttons |= BTN.sprint;
        if (this.held("crouch")) out.buttons |= BTN.crouch;
        if (this.held("fire")) out.buttons |= BTN.fire;
        if (this.held("zoom")) out.buttons |= BTN.zoom;
        for (let i = 1; i <= WEAPONS.length; i++) if (input.wasPressed("weapon" + i)) out.weapon = i;
        this.wheel += input.pointer.wheel;
        if (input.wasPressed("next") || this.wheel > 60) { out.weapon = cycle(me, 1); this.wheel = 0; }
        if (input.wasPressed("prev") || this.wheel < -60) { out.weapon = cycle(me, -1); this.wheel = 0; }
        // the gamepad's left stick pushes down for forward; keys and the touch stick push up
        const padY = -input.stick("LeftY"), keyY = input.axis("moveY");
        const y = Math.abs(padY) > Math.abs(keyY) ? padY : keyY, x = input.axis("moveX");
        // a stick pushed all the way is a sprint, since there is no spare finger for the button
        if (Math.hypot(x, y) > 0.95 && (padY || input.virtualAxes.get("moveY"))) out.buttons |= BTN.sprint;
        out.mx = Math.round(clamp(x, -1, 1) * 127); out.my = Math.round(clamp(y, -1, 1) * 127);
        return out;
    }
}

/** The owned weapon `step` slots along from the one in hand, as a slot number 1..5. */
function cycle(me, step) {
    const n = WEAPONS.length;
    for (let k = 1; k <= n; k++) { const i = (me.weapon + step * k + n * n) % n; if ((me.has >> i) & 1) return i + 1; }
    return 0;
}
