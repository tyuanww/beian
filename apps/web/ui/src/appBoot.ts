/** 进站只拉一次登录态：依赖变了、StrictMode 重跑 effect 都不再重复请求。 */
export function bootOnce(flag: { current: boolean }, run: () => void): void {
  if (flag.current) return;
  flag.current = true;
  run();
}
