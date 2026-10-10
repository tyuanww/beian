const PINS_KEY = "wb_review_pins";
const BOXES_KEY = "wb_review_boxes";
export const REVIEW_DOCK_POPUP_LAYER = 960;

export function readPinsOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(PINS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writePinsOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(PINS_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota */
  }
}

export function readBoxesOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(BOXES_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeBoxesOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(BOXES_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota */
  }
}

export function skipPackSheetField(field?: string): boolean {
  return /^(工艺说明|颜色要求|版本号|更新内容)($|[\s：:·])/.test(String(field || "").trim());
}
