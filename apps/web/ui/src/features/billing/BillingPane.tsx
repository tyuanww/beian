import { Table, Tag, Typography } from "antd";
import type { BillingView, VendorBill } from "../../api";

function vendorTag(v: VendorBill): { color: string; text: string } {
  if (v.status === "partial") return { color: "warning", text: "部分完成" };
  if (v.status === "skip") return { color: "default", text: "暂无账单" };
  if (v.status === "fail" || !v.ok) return { color: "warning", text: "读取不全" };
  return { color: "success", text: "已更新" };
}

export function BillingPane({ billing }: { billing: BillingView | null }) {
  if (!billing) {
    return <Typography.Paragraph type="secondary">正在读取费用…</Typography.Paragraph>;
  }
  return (
    <div>
      <Typography.Paragraph type="secondary">
        {billing.cached_at ? `更新时间：${billing.cached_at}` : "还没有费用数据。"}
      </Typography.Paragraph>
      {(billing.vendors || []).map((v) => {
        const tag = vendorTag(v);
        return (
          <div key={v.vendor} className="bill-vendor">
            <div className="bill-vendor-head">
              <strong>{v.label}</strong>
              <Tag color={tag.color} variant="filled">
                {tag.text}
              </Tag>
            </div>
            <p>{v.message}</p>
            {v.vendor === "minimax" && v.remains ? (
              <p>
                {v.remains.usage_percent != null ? `剩余约 ${v.remains.usage_percent}%` : "剩余情况"}
                {v.remains.remains_time != null ? ` · remains_time ${v.remains.remains_time}` : ""}
                {v.remains.model_count != null ? ` · ${v.remains.model_count} 个模型窗口` : ""}
              </p>
            ) : null}
            {v.balance != null ? <p>余额：{String(v.balance)}</p> : null}
            {v.bills_truncated ? (
              <p>账单未完整加载。</p>
            ) : null}
            {v.bills.length ? (
              <Table
                size="small"
                pagination={false}
                rowKey={(_, i) => `${v.vendor}-${i}`}
                dataSource={v.bills}
                columns={[
                  { title: "月份", dataIndex: "month", width: 100 },
                  { title: "产品", dataIndex: "service" },
                  { title: "计费项", dataIndex: "product" },
                  { title: "金额", dataIndex: "cash", width: 100 },
                  { title: "用量", render: (_, row) => [row.amount, row.unit].filter(Boolean).join(" ") },
                ]}
              />
            ) : null}
          </div>
        );
      })}
      <Typography.Title level={5}>{billing.ledger_label || "调用记录"}</Typography.Title>
      <Typography.Paragraph type="secondary">
        记录本机调用次数。
        {Object.entries(billing.totals || {})
          .map(([k, v]) => `${k} ×${v.count}`)
          .join("；") || "还没有记过调用"}
      </Typography.Paragraph>
      <Table
        size="small"
        pagination={{ pageSize: 8 }}
        rowKey={(r) => `${r.at}-${r.kind}-${r.task_id || ""}-${r.attempt || ""}`}
        dataSource={billing.ledger}
        columns={[
          { title: "时间", dataIndex: "at", width: 200 },
          { title: "厂商", dataIndex: "vendor", width: 90 },
          { title: "类型", dataIndex: "kind", width: 110 },
          { title: "次数", dataIndex: "attempt", width: 70 },
          { title: "状态", dataIndex: "charge_status", width: 90, render: (v: string) => (v === "unknown" ? "未知" : v || "—") },
          { title: "任务", dataIndex: "task_id" },
          { title: "操作人", dataIndex: "actor", width: 90 },
          { title: "备注", dataIndex: "note" },
        ]}
      />
    </div>
  );
}
