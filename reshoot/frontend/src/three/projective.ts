/**
 * Projective texturing: the original photograph, projected from the solved
 * camera onto the proxy geometry, viewed from the new camera.
 *
 * This is what makes step 6 useful with no diffusion backend installed -- it is
 * a real new view of the scene, carrying the original light and colour, just
 * limited by how coarse the proxy is.  It is also uploaded alongside the depth
 * and normal control renders so the server can hand it back as the result when
 * no generator is available.
 *
 * A naive projector paints the photo onto surfaces the original camera could
 * not see, smearing foreground pixels across the walls behind them.  So the
 * scene is first rendered to a depth buffer from the source camera and each
 * fragment checks itself against it, exactly like a shadow map.
 */

import {
  Camera,
  Color,
  DoubleSide,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { depthMaterial, fitDepthRange } from './passes';

const vertexShader = /* glsl */ `
  varying vec4 vSourceClip;
  varying vec3 vWorldNormal;
  uniform mat4 uSourceViewProjection;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vSourceClip = uSourceViewProjection * worldPosition;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uPhoto;
  uniform sampler2D uSourceDepth;
  uniform float uNear;
  uniform float uFar;
  uniform float uBias;
  uniform vec3 uFallbackColor;
  uniform vec3 uLightDirection;
  varying vec4 vSourceClip;
  varying vec3 vWorldNormal;

  void main() {
    // Flat shading for anything the original camera never saw.
    float lambert = 0.35 + 0.65 * max(dot(normalize(vWorldNormal), uLightDirection), 0.0);
    vec3 fallback = uFallbackColor * lambert;

    if (vSourceClip.w <= 0.0) {
      gl_FragColor = vec4(fallback, 1.0);
      return;
    }
    vec3 ndc = vSourceClip.xyz / vSourceClip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(fallback, 1.0);
      return;
    }

    // uSourceDepth stores 1 - normalised view depth, matching depthMaterial.
    float storedDepth = uNear + (1.0 - texture2D(uSourceDepth, uv).r) * (uFar - uNear);
    float fragmentDepth = vSourceClip.w;
    if (fragmentDepth > storedDepth + uBias) {
      gl_FragColor = vec4(fallback, 1.0);
      return;
    }

    // The photo texture is uploaded unflipped, so v runs top-down.
    vec3 photo = texture2D(uPhoto, vec2(uv.x, 1.0 - uv.y)).rgb;
    gl_FragColor = vec4(photo, 1.0);
  }
`;

export class ProjectiveTexturer {
  readonly material: ShaderMaterial;
  private depthTarget: WebGLRenderTarget;

  constructor(photo: Texture, resolution = 1024) {
    photo.flipY = false;
    photo.needsUpdate = true;

    this.depthTarget = new WebGLRenderTarget(resolution, resolution, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });

    this.material = new ShaderMaterial({
      uniforms: {
        uPhoto: { value: photo },
        uSourceDepth: { value: this.depthTarget.texture },
        uSourceViewProjection: { value: new Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 30 },
        // Generous, because the proxy geometry is only approximately where the
        // real surfaces are; too tight and everything falls back to flat grey.
        uBias: { value: 0.25 },
        uFallbackColor: { value: new Color('#6b7484') },
        uLightDirection: { value: new Vector3(0.4, 0.85, 0.35).normalize() },
      },
      vertexShader,
      fragmentShader,
      side: DoubleSide,
    });
  }

  /**
   * Refresh the source-camera depth buffer.  Call whenever the scene changes;
   * the source camera itself never moves, so a static scene needs this once.
   */
  updateSourceDepth(renderer: WebGLRenderer, scene: Scene, sourceCamera: PerspectiveCamera): void {
    const range = fitDepthRange(scene, sourceCamera);
    depthMaterial.uniforms.uNear.value = range.near;
    depthMaterial.uniforms.uFar.value = range.far;
    this.material.uniforms.uNear.value = range.near;
    this.material.uniforms.uFar.value = range.far;

    sourceCamera.updateMatrixWorld(true);
    this.material.uniforms.uSourceViewProjection.value
      .copy(sourceCamera.projectionMatrix)
      .multiply(sourceCamera.matrixWorldInverse);

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(scene, sourceCamera);
    scene.overrideMaterial = previousOverride;
    renderer.setRenderTarget(previousTarget);
  }

  /** Render the scene from `camera` with the photo projected onto it. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.material;
    renderer.render(scene, camera);
    scene.overrideMaterial = previousOverride;
  }

  dispose(): void {
    this.depthTarget.dispose();
    this.material.dispose();
  }
}

/** Load the project photo as a texture suitable for projection. */
export function loadPhotoTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const texture = new Texture(image);
      texture.flipY = false;
      texture.needsUpdate = true;
      resolve(texture);
    };
    image.onerror = () => reject(new Error('Could not load the photo for projection'));
    image.src = url;
  });
}
