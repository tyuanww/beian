/** Isolated Mac upgrade candidate identity. Not a global mode→profile default. */

export const ISOLATED_UPGRADE_PROFILE_ID = "packshot-carton-geometry-v1" as const;
export const ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256 =
  "sha256:74a17949ac80cd1f3fa34640dcaf246a8a656dc78989e0b08589cb2306860aca" as const;
export const ISOLATED_UPGRADE_REGISTRY_SHA256 =
  "5182a72f66a134cc84619113af431524e627252e91909fa91f4022d5c22a07c6" as const;

export type IsolatedUpgradeCandidate = Readonly<{
  profileId: typeof ISOLATED_UPGRADE_PROFILE_ID;
  declaredSha256: typeof ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256;
}>;

function normalizeProfileDeclaredSha256(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

export function assertIsolatedUpgradeCandidate(candidate: {
  profileId: string;
  declaredSha256: string;
}): IsolatedUpgradeCandidate {
  const declared = normalizeProfileDeclaredSha256(candidate.declaredSha256);
  if (candidate.profileId !== ISOLATED_UPGRADE_PROFILE_ID || declared !== ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256) {
    throw new Error("upgrade_candidate_identity_invalid");
  }
  return Object.freeze({ profileId: ISOLATED_UPGRADE_PROFILE_ID, declaredSha256: ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256 });
}
