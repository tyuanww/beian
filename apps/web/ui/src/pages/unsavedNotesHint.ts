/** 签字/退回因未存备注灰掉时，旁边写的原因。 */
export function unsavedNotesHint(hasUnsavedNotes: boolean): string | null {
  return hasUnsavedNotes ? "备注未保存，请先保存" : null;
}
