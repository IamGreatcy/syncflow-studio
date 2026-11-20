import { useEffect, useState } from 'react';
import { Copy, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import {
  buildThailandScheduleRulesForAccounts,
  type ClipTypeFilter,
  type ScheduleRule,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts } from '../api';
import { AppleSwitch } from './AppleUI';
import { PlatformPill } from './PlatformBadge';

interface Props {
  channel: ChannelWithAccounts;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

const DAYS: Array<{ dow: number; label: string }> = [
  { dow: 1, label: 'จันทร์' },
  { dow: 2, label: 'อังคาร' },
  { dow: 3, label: 'พุธ' },
  { dow: 4, label: 'พฤหัสบดี' },
  { dow: 5, label: 'ศุกร์' },
  { dow: 6, label: 'เสาร์' },
  { dow: 0, label: 'อาทิตย์' },
];

type DraftRule = Omit<ScheduleRule, 'id' | 'channelId' | 'createdAt'> & {
  tempId: string;
};

export function ScheduleMatrixView({ channel, onNotify }: Props) {
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getScheduleRules(channel.id).then((res) => {
      setRules(
        res.rules.map((r) => ({
          tempId: r.id,
          socialAccountId: r.socialAccountId,
          dayOfWeek: r.dayOfWeek,
          clipType: r.clipType,
          slotOrder: r.slotOrder,
          localTime: r.localTime,
          isActive: r.isActive,
        }))
      );
    });
  }, [channel.id]);

  function addRule(socialAccountId: string, dayOfWeek: number) {
    setRules((prev) => [
      ...prev,
      {
        tempId: `${socialAccountId}-${dayOfWeek}-${Date.now()}`,
        socialAccountId,
        dayOfWeek,
        clipType: 'ANY',
        slotOrder:
          prev.filter(
            (r) =>
              r.socialAccountId === socialAccountId && r.dayOfWeek === dayOfWeek
          ).length + 1,
        localTime: '19:00',
        isActive: true,
      },
    ]);
  }

  function updateRule(tempId: string, patch: Partial<DraftRule>) {
    setRules((prev) =>
      prev.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r))
    );
  }

  function removeRule(tempId: string) {
    setRules((prev) => prev.filter((r) => r.tempId !== tempId));
  }

  function copyMondayToWeekdays() {
    const mondayRules = rules.filter((r) => r.dayOfWeek === 1);
    const kept = rules.filter(
      (r) => r.dayOfWeek === 0 || r.dayOfWeek === 1 || r.dayOfWeek === 6
    );
    const cloned: DraftRule[] = [];
    for (const dow of [2, 3, 4, 5]) {
      for (const mr of mondayRules) {
        cloned.push({
          ...mr,
          tempId: `${mr.socialAccountId}-${dow}-${Math.random()}`,
          dayOfWeek: dow,
        });
      }
    }
    setRules([...kept, ...cloned]);
    onNotify?.('success', 'คัดลอกเวลาวันจันทร์ไปอังคาร–ศุกร์แล้ว (กดบันทึกเพื่อยืนยัน)');
  }

  function applyThailandOptimalPreset() {
    const generated = buildThailandScheduleRulesForAccounts(channel.accounts);
    setRules(
      generated.map((r, idx) => ({
        ...r,
        tempId: `th-${r.socialAccountId}-${r.dayOfWeek}-${r.clipType}-${idx}`,
      }))
    );
    onNotify?.(
      'success',
      'โหลดตารางเวลาแนะนำสำหรับคนไทยครบ 7 วันแล้ว (กด "บันทึกตารางเวลา" เพื่อยืนยัน)'
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = rules.map(({ tempId: _ignore, ...rest }) => rest);
      await api.saveScheduleRules(channel.id, payload);
      onNotify?.('success', 'บันทึกตารางเวลาประจำแพลตฟอร์มเรียบร้อย');
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[22px] text-apple-label">
            ตารางเวลาลงคลิปประจำสัปดาห์
          </h2>
          <p className="text-[12.5px] text-apple-secondary">
            Timezone: {channel.timezone} • กำหนดเวลาแยกอิสระสำหรับแต่ละแพลตฟอร์มในแต่ละวัน
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={applyThailandOptimalPreset}
            className="apple-btn-secondary"
          >
            <Sparkles className="h-3.5 w-3.5 text-apple-blue" />
            ใช้เวลาแนะนำของไทย (จ.–อา.)
          </button>
          <button
            type="button"
            onClick={copyMondayToWeekdays}
            className="apple-btn-secondary"
          >
            <Copy className="h-3.5 w-3.5" />
            คัดลอกจันทร์ → อังคาร–ศุกร์
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="apple-btn-primary"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'กำลังบันทึก...' : 'บันทึกตารางเวลา'}
          </button>
        </div>
      </div>

      <div className="apple-card overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-left text-[12px]">
          <thead>
            <tr
              className="border-b bg-apple-window"
              style={{ borderColor: 'var(--separator)' }}
            >
              <th className="w-48 px-4 py-3 font-semibold text-apple-secondary">
                Platform / บัญชี
              </th>
              {DAYS.map((d) => (
                <th
                  key={d.dow}
                  className={`px-3 py-3 text-center font-semibold ${
                    d.dow === 0 || d.dow === 6
                      ? 'text-apple-label'
                      : 'text-apple-secondary'
                  }`}
                >
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-apple-window">
            {channel.accounts.map((acc) => (
              <tr
                key={acc.id}
                className="border-b align-top transition hover:bg-apple-hover/40"
                style={{ borderColor: 'var(--separator)' }}
              >
                <td className="px-4 py-3.5">
                  <div className="space-y-1.5">
                    <PlatformPill platform={acc.platform} />
                    <p className="text-[12px] font-medium text-apple-label">
                      {acc.accountName}
                    </p>
                  </div>
                </td>

                {DAYS.map((d) => {
                  const cellRules = rules.filter(
                    (r) =>
                      r.socialAccountId === acc.id && r.dayOfWeek === d.dow
                  );
                  return (
                    <td
                      key={d.dow}
                      className="border-l p-2.5"
                      style={{ borderColor: 'var(--separator)' }}
                    >
                      <div className="space-y-2">
                        {cellRules.map((r) => (
                          <div
                            key={r.tempId}
                            className={`rounded-[11px] border bg-apple-card p-2 transition ${
                              r.isActive ? '' : 'opacity-45'
                            }`}
                            style={{ borderColor: 'var(--separator)' }}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <input
                                type="time"
                                value={r.localTime}
                                onChange={(e) =>
                                  updateRule(r.tempId, {
                                    localTime: e.target.value,
                                  })
                                }
                                className="apple-input py-1 px-1.5 text-[12px] font-semibold tabular-nums"
                              />
                              <button
                                type="button"
                                onClick={() => removeRule(r.tempId)}
                                className="rounded-full p-1 text-apple-tertiary transition hover:text-apple-red"
                                title="ลบเวลา"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-1.5">
                              <select
                                value={r.clipType}
                                onChange={(e) =>
                                  updateRule(r.tempId, {
                                    clipType: e.target.value as ClipTypeFilter,
                                  })
                                }
                                className="apple-input py-0.5 px-1.5 text-[10.5px]"
                              >
                                <option value="ANY">ทุกคลิป</option>
                                <option value="SHORT">เฉพาะสั้น</option>
                                <option value="LONG">เฉพาะยาว</option>
                              </select>
                              <AppleSwitch
                                checked={r.isActive}
                                onChange={(val) =>
                                  updateRule(r.tempId, { isActive: val })
                                }
                              />
                            </div>
                          </div>
                        ))}

                        <button
                          type="button"
                          onClick={() => addRule(acc.id, d.dow)}
                          className="flex w-full items-center justify-center gap-1 rounded-[9px] border border-dashed py-1.5 text-[11px] font-medium text-apple-secondary transition hover:border-apple-blue hover:text-apple-blue"
                          style={{ borderColor: 'var(--separator-strong)' }}
                        >
                          <Plus className="h-3 w-3" /> เพิ่มเวลา
                        </button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
