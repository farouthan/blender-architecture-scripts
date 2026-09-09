/**
 * The phone as the camera.
 *
 * Device orientation is reported as intrinsic Z-X'-Y'' angles relative to a
 * fixed earth frame, so the raw quaternion has an arbitrary heading.  What the
 * user wants is *relative* motion: picking the phone up should not teleport the
 * view.  So the first reading is stored as a reference and every later reading
 * is applied as a delta on top of the camera orientation at that moment.
 *
 * iOS 13 and later gate the sensor behind a permission prompt that must be
 * triggered by a user gesture on a secure origin.
 */

import { Euler, Quaternion, Vector3 } from 'three';

type PermissionCapableCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

const ZEE = new Vector3(0, 0, 1);
// -90 degrees about x: the device frame looks out of the screen, a camera looks
// out of the back.
const SCREEN_TO_CAMERA = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

function deviceQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): Quaternion {
  const euler = new Euler(beta, alpha, -gamma, 'YXZ');
  const q = new Quaternion().setFromEuler(euler);
  q.multiply(SCREEN_TO_CAMERA);
  q.multiply(new Quaternion().setFromAxisAngle(ZEE, -screenAngle));
  return q;
}

export type DeviceOrientationStatus =
  | 'idle'
  | 'unsupported'
  | 'insecure'
  | 'denied'
  | 'waiting'
  | 'running';

export class DeviceOrientationSource {
  private reference: Quaternion | null = null;
  private latest = new Quaternion();
  private baseCamera = new Quaternion();
  private listening = false;

  status: DeviceOrientationStatus = 'idle';
  onStatusChange: ((status: DeviceOrientationStatus) => void) | null = null;

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /**
   * Ask for the sensor and start listening.  `cameraQuaternion` is the camera
   * orientation to treat as the neutral pose.
   */
  async start(cameraQuaternion: Quaternion): Promise<DeviceOrientationStatus> {
    if (!DeviceOrientationSource.supported) return this.setStatus('unsupported');
    if (!window.isSecureContext) return this.setStatus('insecure');

    const ctor = DeviceOrientationEvent as PermissionCapableCtor;
    if (typeof ctor.requestPermission === 'function') {
      this.setStatus('waiting');
      try {
        if ((await ctor.requestPermission()) !== 'granted') return this.setStatus('denied');
      } catch {
        return this.setStatus('denied');
      }
    }

    this.baseCamera.copy(cameraQuaternion);
    this.reference = null;
    if (!this.listening) {
      window.addEventListener('deviceorientation', this.onEvent, true);
      this.listening = true;
    }
    return this.setStatus('running');
  }

  stop(): void {
    if (this.listening) {
      window.removeEventListener('deviceorientation', this.onEvent, true);
      this.listening = false;
    }
    this.reference = null;
    this.setStatus('idle');
  }

  /** Re-zero the phone: the current pose becomes the neutral one. */
  recentre(cameraQuaternion: Quaternion): void {
    this.baseCamera.copy(cameraQuaternion);
    this.reference = null;
  }

  /** Camera orientation implied by the phone, or null if there is no reading. */
  read(target: Quaternion): boolean {
    if (this.status !== 'running' || !this.reference) return false;
    target
      .copy(this.baseCamera)
      .multiply(this.reference.clone().invert())
      .multiply(this.latest);
    return true;
  }

  private onEvent = (event: DeviceOrientationEvent) => {
    if (event.alpha === null || event.beta === null || event.gamma === null) return;
    const toRad = Math.PI / 180;
    const screenAngle = ((screen.orientation?.angle ?? 0) as number) * toRad;
    this.latest.copy(
      deviceQuaternion(
        event.alpha * toRad,
        event.beta * toRad,
        event.gamma * toRad,
        screenAngle,
      ),
    );
    if (!this.reference) this.reference = this.latest.clone();
  };

  private setStatus(status: DeviceOrientationStatus): DeviceOrientationStatus {
    this.status = status;
    this.onStatusChange?.(status);
    return status;
  }
}

export const STATUS_MESSAGES: Record<DeviceOrientationStatus, string> = {
  idle: 'Phone motion is off.',
  unsupported: 'This browser does not report device motion.',
  insecure: 'Phone motion needs an https connection. Run the server with --cert and --key.',
  denied: 'Motion access was declined. Enable it in the browser settings and try again.',
  waiting: 'Waiting for motion permission...',
  running: 'Phone motion is driving the camera.',
};
