/**
 * 已提交的发布开关。靠发版生效，不读环境变量，也没有调试覆盖：
 * 仓库没有已提交的 env 机制（config.ts 只读本机未提交的 .env*），在杭州改 .env 属于手工改生产配置。
 * 改值 = 发一个只改本文件的 PR，经 owner 批准后合并发版；回滚同理（实测开 PR 到发布约 16 分钟）。
 */

/** 旧打样 GLB 的 WebP 旁路是否对外返回（/api/mockups/:id/files/glb 与 texture_format）。默认关。 */
export const GLB_WEBP_VARIANT = false;

/** 回填（PR-b）每个服务进程生命周期最多处理的文件数。0 = 不回填。 */
export const GLB_WEBP_BACKFILL_LIMIT = 0;

/** 回填单文件上限：32MB。按 estimateGlbWebpMs = 10s + 5s/MB 估算最坏拖慢新单约 170 秒（非实测）。 */
export const GLB_WEBP_BACKFILL_MAX_BYTES = 32 * 1024 * 1024;

/** 回填每个文件后检查 RSS，超过即停止本轮。 */
export const GLB_WEBP_BACKFILL_MAX_RSS_MB = 1536;
