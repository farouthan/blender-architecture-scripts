/**
 * The proxy scene: primitive stand-ins for the furniture plus a posed body for
 * each person.  Steps 3 and 4 edit it, step 5 flies through it, and step 6
 * renders its depth and normals as the control signal for the generator.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Body, Primitive } from '../types';

export const SELECTED_EMISSIVE = 0x2b6cb0;

/** Bone thickness by the joint the bone ends at, in metres per unit stature. */
const BONE_RADIUS: Record<string, number> = {
  spine1: 0.085, spine2: 0.085, spine3: 0.08, neck: 0.045, head: 0.05,
  left_hip: 0.06, right_hip: 0.06, left_knee: 0.055, right_knee: 0.055,
  left_ankle: 0.045, right_ankle: 0.045, left_foot: 0.035, right_foot: 0.035,
  left_collar: 0.05, right_collar: 0.05, left_shoulder: 0.05, right_shoulder: 0.05,
  left_elbow: 0.04, right_elbow: 0.04, left_wrist: 0.033, right_wrist: 0.033,
  left_hand: 0.028, right_hand: 0.028,
};
const DEFAULT_BONE_RADIUS = 0.05;

export interface SceneEntry {
  id: string;
  kind: 'primitive' | 'body';
  object: Object3D;
}

function geometryFor(primitive: Primitive): BufferGeometry {
  const [sx, sy, sz] = primitive.size;
  switch (primitive.kind) {
    case 'plane':
      return new PlaneGeometry(Math.max(sx, 0.1), Math.max(sz, 0.1));
    case 'cylinder':
      return new CylinderGeometry(
        Math.max(sx, 0.02) / 2,
        Math.max(sz, 0.02) / 2,
        Math.max(sy, 0.02),
        24,
      );
    default:
      return new BoxGeometry(
        Math.max(sx, 0.02),
        Math.max(sy, 0.02),
        Math.max(sz, 0.02),
      );
  }
}

export function buildPrimitiveMesh(primitive: Primitive): Mesh {
  const material = new MeshStandardMaterial({
    color: new Color(primitive.color || '#8a93a5'),
    roughness: 0.85,
    metalness: 0.0,
    side: primitive.kind === 'plane' ? DoubleSide : undefined,
  });
  const mesh = new Mesh(geometryFor(primitive), material);
  mesh.position.set(...primitive.position);
  if (primitive.kind === 'plane') {
    mesh.rotation.set(-Math.PI / 2, 0, primitive.rotationY);
  } else {
    mesh.rotation.set(0, primitive.rotationY, 0);
  }
  mesh.visible = !primitive.hidden;
  mesh.userData = { id: primitive.id, kind: 'primitive' };
  mesh.name = primitive.label || primitive.id;
  return mesh;
}

/** A capsule rig from the joint list; used for template and recovered bodies. */
export function buildBodyGroup(body: Body): Group {
  const group = new Group();
  group.name = body.id;
  group.userData = { id: body.id, kind: 'body' };

  const material = new MeshStandardMaterial({
    color: new Color('#d8b08c'),
    roughness: 0.75,
    metalness: 0.0,
  });
  const scaleFromStature = body.height / 1.7;
  const joints = body.joints.map((j) => new Vector3(j[0], j[1], j[2]));
  const up = new Vector3(0, 1, 0);

  body.parents.forEach((parent, index) => {
    if (parent < 0 || !joints[index] || !joints[parent]) return;
    const a = joints[parent];
    const b = joints[index];
    const delta = new Vector3().subVectors(b, a);
    const length = delta.length();
    if (length < 1e-3) return;
    const radius =
      (BONE_RADIUS[body.names[index]] ?? DEFAULT_BONE_RADIUS) * scaleFromStature;
    const bone = new Mesh(
      new CapsuleGeometry(radius, Math.max(length - radius, 0.01), 4, 10),
      material,
    );
    bone.position.copy(a).addScaledVector(delta, 0.5);
    bone.quaternion.setFromUnitVectors(up, delta.clone().normalize());
    group.add(bone);
  });

  const headIndex = body.names.indexOf('head');
  if (headIndex >= 0 && joints[headIndex]) {
    const head = new Mesh(new SphereGeometry(0.105 * scaleFromStature, 18, 14), material);
    head.position.copy(joints[headIndex]).addScaledVector(up, 0.045 * scaleFromStature);
    group.add(head);
  }

  group.position.set(body.position[0], body.position[1], body.position[2]);
  group.rotation.y = body.rotationY;
  return group;
}

/** Builds and rebuilds the scene graph from plain state. */
export class ProxySceneBuilder {
  readonly scene = new Scene();
  readonly primitiveRoot = new Group();
  readonly bodyRoot = new Group();

  private entries = new Map<string, SceneEntry>();
  private selected: string | null = null;
  private originalEmissive = new Map<string, number>();

  constructor() {
    this.scene.add(this.primitiveRoot, this.bodyRoot);
    this.scene.background = new Color('#0a0d12');
  }

  setPrimitives(primitives: Primitive[]): void {
    this.disposeGroup(this.primitiveRoot);
    for (const primitive of primitives) {
      const mesh = buildPrimitiveMesh(primitive);
      this.primitiveRoot.add(mesh);
      this.entries.set(primitive.id, { id: primitive.id, kind: 'primitive', object: mesh });
    }
    this.applySelection();
  }

  setBodies(bodies: Body[]): void {
    this.disposeGroup(this.bodyRoot);
    for (const body of bodies) {
      const group = buildBodyGroup(body);
      this.bodyRoot.add(group);
      this.entries.set(body.id, { id: body.id, kind: 'body', object: group });
    }
    this.applySelection();
  }

  get(id: string): SceneEntry | undefined {
    return this.entries.get(id);
  }

  select(id: string | null): void {
    this.selected = id;
    this.applySelection();
  }

  getSelected(): string | null {
    return this.selected;
  }

  private applySelection(): void {
    for (const [id, entry] of this.entries) {
      entry.object.traverse((node) => {
        const mesh = node as Mesh;
        const material = mesh.material as MeshStandardMaterial | undefined;
        if (!material || !('emissive' in material)) return;
        const key = mesh.uuid;
        if (!this.originalEmissive.has(key)) {
          this.originalEmissive.set(key, material.emissive.getHex());
        }
        material.emissive.setHex(
          id === this.selected ? SELECTED_EMISSIVE : this.originalEmissive.get(key) ?? 0x000000,
        );
      });
    }
  }

  private disposeGroup(group: Group): void {
    for (const child of [...group.children]) {
      child.traverse((node) => {
        const mesh = node as Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose?.();
        this.originalEmissive.delete(mesh.uuid);
      });
      const id = (child.userData as { id?: string }).id;
      if (id) this.entries.delete(id);
      group.remove(child);
    }
  }

  dispose(): void {
    this.disposeGroup(this.primitiveRoot);
    this.disposeGroup(this.bodyRoot);
  }
}

/** Move an existing body group without rebuilding its meshes. */
export function applyBodyTransform(group: Object3D, body: Body): void {
  group.position.set(body.position[0], body.position[1], body.position[2]);
  group.rotation.y = body.rotationY;
}

/** Move an existing primitive mesh without rebuilding its geometry. */
export function applyPrimitiveTransform(mesh: Mesh, primitive: Primitive): void {
  mesh.position.set(...primitive.position);
  if (primitive.kind === 'plane') mesh.rotation.set(-Math.PI / 2, 0, primitive.rotationY);
  else mesh.rotation.set(0, primitive.rotationY, 0);
  mesh.visible = !primitive.hidden;
}

/** Rebuild a primitive's geometry in place after its size or kind changed. */
export function applyPrimitiveGeometry(mesh: Mesh, primitive: Primitive): void {
  mesh.geometry.dispose();
  mesh.geometry = geometryFor(primitive);
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(primitive.color || '#8a93a5');
  applyPrimitiveTransform(mesh, primitive);
}
