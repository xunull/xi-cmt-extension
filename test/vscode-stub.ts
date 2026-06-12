// Minimal VS Code API stub for unit tests running outside the VS Code runtime.
// Only include the parts needed by the modules under test.
export class Range {
  constructor(
    public startLine: number,
    public startCharacter: number,
    public endLine: number,
    public endCharacter: number
  ) {}
}

export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;
