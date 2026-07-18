/**
 * steer.ts — the analog-stick → rotate/thrust translation, kept pure so the
 * angle math can be tested without a canvas or the sim.
 *
 * The touch joystick gives a desired HEADING; the ship rotates at a fixed rate
 * and thrusts along its facing. This maps the two onto the SAME input bitmask
 * the sim and netcode already speak (IN_LEFT/IN_RIGHT/IN_THRUST), so analog
 * control changes nothing on the wire — it is a purely local reading of intent.
 */

import { IN_LEFT, IN_RIGHT, IN_THRUST } from './game/sim';

/**
 * Given where the stick points (`wantAngle`) and where the ship faces
 * (`shipAng`), return the rotate + thrust bits. Turn toward the target (the
 * shortest way round) unless already within `deadband`, and thrust once facing
 * within `thrustCone` of it so the ship flies where you push.
 */
export function autoSteer(
  wantAngle: number,
  shipAng: number,
  deadband = 0.1,
  thrustCone = 0.9,
): number {
  // Shortest signed angle from facing to target, in [-π, π].
  const err = Math.atan2(Math.sin(wantAngle - shipAng), Math.cos(wantAngle - shipAng));
  let m = 0;
  if (err > deadband) m |= IN_RIGHT; // IN_RIGHT increases ang
  else if (err < -deadband) m |= IN_LEFT;
  if (Math.abs(err) < thrustCone) m |= IN_THRUST;
  return m;
}
