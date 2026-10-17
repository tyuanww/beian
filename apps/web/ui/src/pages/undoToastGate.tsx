import { useSyncExternalStore, type ReactNode } from "react";

/** 一个布尔值的外部 store：给渲染在 antd message 容器里（不在本页组件树内）的内容读页面状态。 */
export type FlagStore = {
  get: () => boolean;
  set: (next: boolean) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createFlagStore(initial = false): FlagStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 撤销提示的内容开关：锁页（hidden=true）的同一次提交里就不再渲染内容，
 * 不等 antd message 的退出动画（无兜底时限，靠 animationend 才删节点）。
 */
export function UndoToastGate({ hidden, children }: { hidden: FlagStore; children: ReactNode }) {
  const isHidden = useSyncExternalStore(hidden.subscribe, hidden.get, hidden.get);
  return isHidden ? null : <>{children}</>;
}
