/**
 * layout.test.ts — the two CSS rules a phone will not forgive.
 *
 * jsdom has no layout engine, so these cannot be asserted by measuring. They are
 * asserted against the stylesheet SOURCE instead, which is honest about what it
 * proves: not "the canvas fills the arena" but "the mechanism that made it fill
 * is still here". Both of these bugs are invisible on a desktop and fatal on a
 * phone, and one of them has already shipped once from this factory.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createInput, type Input } from '@ben-gy/game-engine/input';

const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'main.css'), 'utf8');

/**
 * The same key map main.ts hands createInput. It matters that this is the real
 * one and not a stub: the overlay tests below assert that a touch button drives
 * "the same action the keyboard does", and that claim is only worth anything if
 * the keyboard half is wired to the actions the game truly binds.
 */
const KEYS: Record<string, string> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'up',
  Space: 'fire',
  KeyP: 'pause',
  KeyM: 'mute',
};

/** The declaration block for a selector, or ''. */
function ruleFor(selector: string): string {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('the canvas fills the arena on a phone', () => {
  it('positions the canvas rather than resolving a percentage height', () => {
    // Measured at 375×812 before the fix: a 774px-tall arena containing a 188px
    // canvas — 375/2, the canvas's own default 300×150 aspect ratio, because
    // `height:100%` cannot resolve against a parent whose height comes from
    // flex-grow through two levels of auto-height ancestors. resize() then baked
    // the collapsed size into the canvas attributes, so it stayed wrong. Two
    // thirds of the screen was dead. It looked perfect on a desktop.
    const rule = ruleFor('.arena canvas');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('inset: 0');
  });

  it('gives the canvas a positioned ancestor to fill', () => {
    // inset:0 is measured against the nearest positioned ancestor. Without this,
    // the canvas would fill the VIEWPORT and sit over the HUD and the footer.
    expect(ruleFor('.arena')).toContain('position: relative');
  });

  it('lets the arena shrink, so a short viewport cannot overflow the page', () => {
    const rule = ruleFor('.arena');
    expect(rule).toContain('min-height: 0');
  });
});

describe('the [hidden] gate', () => {
  it('overrides display with !important', () => {
    // Safari's UA `[hidden]` rule is not !important, so any class that sets
    // `display` on an element also toggled with the `hidden` attribute WINS —
    // and a blurred, dimmed, tap-eating overlay stays on top of the game. This
    // shipped in gravity-golf and reached real players.
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('is declared before the overlay rules it has to beat', () => {
    // Equal specificity → source order decides. A later `.overlay { display:flex }`
    // would win if this rule came first... which is exactly why it carries
    // !important rather than relying on position. Assert both properties hold.
    const hiddenAt = css.search(/\[hidden\]\s*\{/);
    expect(hiddenAt).toBeGreaterThanOrEqual(0);
    expect(css.slice(hiddenAt, hiddenAt + 60)).toContain('!important');
  });
});

describe('the touch overlay', () => {
  let input: Input | null = null;
  afterEach(() => {
    input?.destroy();
    input = null;
  });

  it('renders a d-pad and the fire button when touch is on', () => {
    // The overlay is auto-gated on `(pointer: coarse)`, which a desktop browser
    // emulating a small viewport does NOT report — so this is the only place the
    // phone controls actually get exercised.
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    input = createInput({ target, keys: KEYS, touch: true, buttons: [{ action: 'fire', label: '●' }] });

    const root = document.querySelector('.vcontrols');
    expect(root).toBeTruthy();
    const btns = root!.querySelectorAll('.vbtn');
    // Four directions plus fire. The game only uses up/left/right, but a missing
    // button is a control the player cannot reach.
    expect(btns.length).toBe(5);
    expect([...btns].map((b) => b.textContent)).toEqual(expect.arrayContaining(['↑', '←', '→', '●']));
  });

  it('meets the 44px tap target minimum', () => {
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    input = createInput({ target, keys: KEYS, touch: true, buttons: [{ action: 'fire', label: '●' }] });
    for (const b of document.querySelectorAll<HTMLElement>('.vbtn')) {
      expect(parseInt(b.style.width, 10)).toBeGreaterThanOrEqual(44);
      expect(parseInt(b.style.height, 10)).toBeGreaterThanOrEqual(44);
    }
  });

  it('a touch on the pad moves the axis the ship reads', () => {
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    input = createInput({ target, keys: KEYS, touch: true, buttons: [{ action: 'fire', label: '●' }] });
    const left = [...document.querySelectorAll<HTMLElement>('.vbtn')].find((b) => b.textContent === '←')!;
    left.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    expect(input.state.axis.x).toBeLessThan(0);
    left.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(input.state.axis.x).toBe(0);
  });

  it('the fire button drives the same action the keyboard does', () => {
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    input = createInput({ target, keys: KEYS, touch: true, buttons: [{ action: 'fire', label: '●' }] });
    const fire = [...document.querySelectorAll<HTMLElement>('.vbtn')].find((b) => b.textContent === '●')!;
    fire.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    expect(input.state.down.has('fire')).toBe(true);
    fire.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(input.state.down.has('fire')).toBe(false);
  });

  it('is removed on teardown, so a menu is never left with a d-pad on it', () => {
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    const i = createInput({ target, keys: KEYS, touch: true, buttons: [{ action: 'fire', label: '●' }] });
    expect(document.querySelector('.vcontrols')).toBeTruthy();
    i.destroy();
    expect(document.querySelector('.vcontrols')).toBeNull();
  });
});
