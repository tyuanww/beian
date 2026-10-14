const PINS_KEY = "wb_review_pins";
const BOXES_KEY = "wb_review_boxes";
const SPOT_KEY = "wb_review_spot";

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

/** 就地对照默认开。关掉后回到右栏里展开这一条。 */
export function readSpotOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(SPOT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSpotOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(SPOT_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota */
  }
}

export function skipPackSheetField(field?: string): boolean {
  return /^(工艺说明|颜色要求|版本号|更新内容)($|[\s：:·])/.test(String(field || "").trim());
}
