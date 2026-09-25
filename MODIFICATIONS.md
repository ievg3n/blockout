# Modifications

This distribution is derived from Blockout by Sam Wasserman and retains the
original `LICENSE`, `NOTICE`, credits, and citation metadata.

Frozen upstream base: `6a85105101a0504e38c330b0caae010c957b2321`.

Portable desktop work added in 2026, contributed by
**Gumbii Digital** ([github.com/GumbiiDigital](https://github.com/GumbiiDigital)):

- Windows 11 x64 packaging with a per-user NSIS installer and native window chrome.
- Portable project-relative paths, Windows-safe filenames, and cross-platform UI labels.
- Shared platform configuration and FFmpeg discovery with deterministic asset checks.
- Versioned local-control discovery compatible with existing unversioned descriptors.
- Process-tree-aware export cancellation and cross-platform FFmpeg concat files.
- Windows/macOS/Linux CI, packaging provenance, third-party notices, and SBOM generation.

Pose animation and editor work added in 2026 in the
[ievg3n/blockout](https://github.com/ievg3n/blockout) fork:

- Point-by-point limb animation for people: a viewport pose tool with IK joint
  handles, pose keys on the shot clock (`BlockingTake.poses`), a timeline pose
  lane, quick poses, mirror/copy/paste, and MCP `set_pose_key` /
  `list_pose_joints` (new: `src/engine/pose.ts`,
  `src/renderer/viewport/pose-ik.ts`, `src/renderer/panels/PosePanel.tsx`).
- Person rig: wrist and ankle joints, body height, and corrected X-axis and
  shoulder/hip abduction signs so motion presets render as documented.
- Drag-resizable side panels (new: `src/renderer/panels/PanelResizer.tsx`) and
  a timeline playhead offset fix.
- Reference analysis on `claude-opus-5` with server-side refusal fallback.

Downstream distributors should append their own branding and behavioral changes
to this file rather than replacing the original attribution.

Every upstream file changed by this port and capable of carrying comments has
a prominent first-lines notice pointing back to this manifest. The following
changed structured/generated files cannot accept comments without invalidating
their format, so this manifest is their file-level change notice:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.node.json`

New binary and structured release artifacts are likewise identified here:
`build/icon.ico` and `ASSET_MANIFEST.json`. Patch inputs retain their exact
patch syntax and are documented by path under `third_party/ffmpeg/`.

A stable or commercial distribution remains gated on upstream/trademark
permission, platform code signing/notarization, a final FFmpeg/H.264
distribution review, and the ordinary complete third-party compliance review.
