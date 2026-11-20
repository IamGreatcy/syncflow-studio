import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Link2, X } from 'lucide-react';
import type {
  AppSettingsPublic,
  MetaDiscoveredPage,
  SocialAccount,
} from '@clipflow/shared';
import { api } from '../api';
import { AppleSwitch, InsetGroup, InsetRow, SegmentedControl } from './AppleUI';
import { PlatformPill } from './PlatformBadge';

type ConnectTab = 'token' | 'oauth' | 'unified';

export function ConnectAccountModal({
  account,
  onClose,
  onSuccess,
  onNotify,
}: {
  account: SocialAccount;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}) {
  const [tab, setTab] = useState<ConnectTab>('token');
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [alsoLinkPairedMeta, setAlsoLinkPairedMeta] = useState(true);
  const [metaSessionId, setMetaSessionId] = useState<string | null>(null);
  const [metaPages, setMetaPages] = useState<MetaDiscoveredPage[] | null>(null);

  const [settings, setSettings] = useState<AppSettingsPublic | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const defaultCallbackUrl = `${window.location.origin}/api/oauth/${account.platform.toLowerCase()}/callback`;
  const [callbackUrl, setCallbackUrl] = useState(defaultCallbackUrl);
  const [redirectedUrl, setRedirectedUrl] = useState('');

  const [unifiedBaseUrl, setUnifiedBaseUrl] = useState('');
  const [unifiedApiKey, setUnifiedApiKey] = useState('');
  const [unifiedAccountId, setUnifiedAccountId] = useState(
    account.config?.unifiedAccountId ?? ''
  );

  const isMeta = account.platform === 'FACEBOOK' || account.platform === 'INSTAGRAM';

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((res) => {
        if (!active) return;
        setSettings(res.settings);
        setUnifiedBaseUrl(res.settings.unifiedApiBaseUrl || '');
        if (account.platform === 'YOUTUBE') {
          setClientId(res.settings.googleClientId || '');
        } else if (isMeta) {
          setClientId(res.settings.metaAppId || '');
        } else {
          setClientId(res.settings.tiktokClientKey || '');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [account.platform, isMeta]);

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      onNotify?.('error', 'คัดลอกไม่สำเร็จ');
    }
  }

  async function handleConnectToken() {
    let trimmed = accessToken.trim().replace(/^["']|["']$/g, '');
    let effectiveRefresh = refreshToken.trim().replace(/^["']|["']$/g, '');

    if (trimmed.startsWith('{') && trimmed.includes('access_token')) {
      try {
        const parsedJson = JSON.parse(trimmed) as {
          access_token?: string;
          refresh_token?: string;
        };
        if (parsedJson.access_token) {
          trimmed = parsedJson.access_token.trim();
          setAccessToken(trimmed);
        }
        if (parsedJson.refresh_token && !effectiveRefresh) {
          effectiveRefresh = parsedJson.refresh_token.trim();
          setRefreshToken(effectiveRefresh);
        }
      } catch {
        const atMatch = trimmed.match(/"access_token"\s*:\s*"([^"]+)"/);
        const rtMatch = trimmed.match(/"refresh_token"\s*:\s*"([^"]+)"/);
        if (atMatch?.[1]) {
          trimmed = atMatch[1].trim();
          setAccessToken(trimmed);
        }
        if (rtMatch?.[1] && !effectiveRefresh) {
          effectiveRefresh = rtMatch[1].trim();
          setRefreshToken(effectiveRefresh);
        }
      }
    }

    if (!trimmed) {
      onNotify?.('error', 'กรุณาใส่ Access Token');
      return;
    }

    if (account.platform === 'YOUTUBE' && !trimmed.startsWith('ya29.')) {
      onNotify?.('error', 'Access Token ของ Google ต้องขึ้นต้นด้วย ya29.');
      return;
    }

    setBusy(true);
    try {
      const res = await api.connectAccountToken(account.id, {
        accessToken: trimmed,
        refreshToken: effectiveRefresh || undefined,
        alsoLinkPairedMeta: isMeta ? alsoLinkPairedMeta : false,
      });

      if (res.needsPageSelection && res.sessionId && res.pages) {
        setMetaSessionId(res.sessionId);
        setMetaPages(res.pages);
        return;
      }

      const linkedCount = res.linked?.length ?? 1;
      onNotify?.(
        'success',
        linkedCount > 1
          ? `เชื่อมต่อเรียบร้อย ${linkedCount} แพลตฟอร์ม`
          : 'เชื่อมต่อบัญชีเรียบร้อยแล้ว'
      );
      await onSuccess();
      onClose();
    } catch (error) {
      onNotify?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectMetaPage(pageId: string) {
    if (!metaSessionId) return;
    setBusy(true);
    try {
      const res = await api.selectMetaPage(account.id, {
        sessionId: metaSessionId,
        pageId,
        alsoLinkPairedMeta,
      });
      const linkedCount = res.linked?.length ?? 1;
      onNotify?.(
        'success',
        linkedCount > 1
          ? 'เชื่อม Facebook + Instagram เรียบร้อยแล้ว'
          : 'เชื่อมต่อบัญชีเรียบร้อยแล้ว'
      );
      await onSuccess();
      onClose();
    } catch (error) {
      onNotify?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function hasExistingSecret(): boolean {
    if (!settings) return false;
    if (account.platform === 'YOUTUBE') return settings.hasGoogleClientSecret;
    if (isMeta) return settings.hasMetaAppSecret;
    return settings.hasTiktokClientSecret;
  }

  async function handleSaveAndOpenOAuth() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (account.platform === 'YOUTUBE') {
        if (clientId.trim()) payload.googleClientId = clientId.trim();
        if (clientSecret.trim()) payload.googleClientSecret = clientSecret.trim();
      } else if (isMeta) {
        if (clientId.trim()) payload.metaAppId = clientId.trim();
        if (clientSecret.trim()) payload.metaAppSecret = clientSecret.trim();
      } else {
        if (clientId.trim()) payload.tiktokClientKey = clientId.trim();
        if (clientSecret.trim()) payload.tiktokClientSecret = clientSecret.trim();
      }

      if (Object.keys(payload).length > 0) {
        const updated = await api.updateSettings(payload);
        setSettings(updated.settings);
      }

      const customCallback =
        callbackUrl.trim() && callbackUrl.trim() !== defaultCallbackUrl
          ? callbackUrl.trim()
          : undefined;
      const { url } = await api.getOAuthUrl(account.id, customCallback);
      const width = 560;
      const height = 720;
      const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
      const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
      const popup = window.open(
        url,
        'syncflow_oauth',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      );
      if (!popup) {
        onNotify?.('error', 'เบราว์เซอร์บล็อก Popup กรุณาอนุญาต Popup สำหรับหน้านี้');
      }
    } catch (error) {
      onNotify?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteRedirectUrl() {
    if (!redirectedUrl.trim()) {
      onNotify?.('error', 'กรุณาวาง URL หลัง Login');
      return;
    }
    setBusy(true);
    try {
      await api.completeOAuthUrl(account.id, {
        redirectedUrl: redirectedUrl.trim(),
        redirectUri: callbackUrl.trim() || undefined,
      });
      onNotify?.('success', 'เชื่อมต่อบัญชีเรียบร้อยแล้ว');
      await onSuccess();
      onClose();
    } catch (error) {
      onNotify?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveUnified() {
    if (!unifiedBaseUrl.trim() || !unifiedAccountId.trim()) {
      onNotify?.('error', 'กรุณาระบุ Base URL และ Account ID');
      return;
    }
    setBusy(true);
    try {
      const settingsPayload: Record<string, unknown> = {
        unifiedApiBaseUrl: unifiedBaseUrl.trim(),
      };
      if (unifiedApiKey.trim()) {
        settingsPayload.unifiedApiKey = unifiedApiKey.trim();
      }
      await api.updateSettings(settingsPayload);
      await api.updateAccount(account.id, {
        connectionMode: 'UNIFIED_API',
        status: 'CONNECTED',
        config: {
          ...account.config,
          unifiedAccountId: unifiedAccountId.trim(),
        },
      });
      onNotify?.('success', 'เชื่อม Unified API เรียบร้อยแล้ว');
      await onSuccess();
      onClose();
    } catch (error) {
      onNotify?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="apple-card w-full max-w-md max-h-[90vh] overflow-y-auto p-5 shadow-apple-popover space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <PlatformPill platform={account.platform} />
            <h3 className="truncate text-[16px] font-semibold tracking-tight text-apple-label">
              {account.accountName}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full p-1.5 text-apple-secondary hover:bg-[var(--bg-grouped)] hover:text-apple-label shrink-0"
            aria-label="ปิด"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <SegmentedControl<ConnectTab>
          value={tab}
          onChange={(val) => {
            setTab(val);
            setMetaPages(null);
            setMetaSessionId(null);
          }}
          options={[
            { value: 'token', label: 'Token' },
            { value: 'oauth', label: 'OAuth' },
            { value: 'unified', label: 'Unified API' },
          ]}
        />

        {tab === 'token' && (
          <div className="space-y-3">
            {metaPages && metaPages.length > 0 ? (
              <InsetGroup title="เลือกเพจ">
                {metaPages.map((pg) => (
                  <InsetRow key={pg.pageId}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium text-apple-label">
                          {pg.pageName}
                        </div>
                        <div className="text-[12px] text-apple-secondary">
                          <span className="font-mono">{pg.pageId}</span>
                          {pg.igUsername && (
                            <span className="ml-2 text-apple-green">
                              • @{pg.igUsername}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSelectMetaPage(pg.pageId)}
                        className="apple-btn-primary py-1.5 px-3 text-[12px] shrink-0"
                      >
                        เลือก
                      </button>
                    </div>
                  </InsetRow>
                ))}
              </InsetGroup>
            ) : (
              <>
                <div className="space-y-2.5">
                  <div>
                    <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                      Access Token
                    </label>
                    <textarea
                      rows={3}
                      value={accessToken}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const trimmedRaw = raw.trim();
                        if (trimmedRaw.startsWith('{') && trimmedRaw.includes('access_token')) {
                          try {
                            const parsed = JSON.parse(trimmedRaw) as {
                              access_token?: string;
                              refresh_token?: string;
                            };
                            if (parsed.access_token) {
                              setAccessToken(parsed.access_token.trim());
                              if (parsed.refresh_token) setRefreshToken(parsed.refresh_token.trim());
                              return;
                            }
                          } catch {
                            // Keep raw input until complete
                          }
                        }
                        setAccessToken(raw);
                      }}
                      placeholder="Access Token หรือ JSON"
                      className="apple-input font-mono text-[12px]"
                    />
                  </div>

                  {(account.platform === 'YOUTUBE' || account.platform === 'TIKTOK') && (
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                        Refresh Token
                      </label>
                      <input
                        type="text"
                        value={refreshToken}
                        onChange={(e) => setRefreshToken(e.target.value)}
                        placeholder="Refresh Token (ถ้ามี)"
                        className="apple-input font-mono text-[12px]"
                      />
                    </div>
                  )}

                  {isMeta && (
                    <div
                      className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5"
                      style={{
                        backgroundColor: 'var(--bg-grouped)',
                        border: '1px solid var(--separator)',
                      }}
                    >
                      <span className="text-[13px] font-medium text-apple-label">
                        เชื่อม Facebook + Instagram พร้อมกัน
                      </span>
                      <AppleSwitch
                        checked={alsoLinkPairedMeta}
                        onChange={setAlsoLinkPairedMeta}
                        label="เชื่อมคู่ Meta"
                      />
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onClose}
                    className="apple-btn-secondary"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    disabled={busy || !accessToken.trim()}
                    onClick={() => void handleConnectToken()}
                    className="apple-btn-primary"
                  >
                    <KeyRound className="h-4 w-4" />
                    {busy ? 'กำลังเชื่อม...' : 'เชื่อมต่อ'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'oauth' && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                Callback URI
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  className="apple-input font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => void copyText('callback', callbackUrl)}
                  className="apple-btn-secondary py-2 px-2.5 text-[11px] shrink-0"
                >
                  {copiedKey === 'callback' ? (
                    <Check className="h-3.5 w-3.5 text-apple-green" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                {account.platform === 'YOUTUBE'
                  ? 'Google Client ID'
                  : isMeta
                    ? 'Meta App ID'
                    : 'TikTok Client Key'}
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID / App ID"
                className="apple-input font-mono text-[12px]"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[12px] font-medium text-apple-secondary">
                  {account.platform === 'YOUTUBE'
                    ? 'Google Client Secret'
                    : isMeta
                      ? 'Meta App Secret'
                      : 'TikTok Client Secret'}
                </label>
                {hasExistingSecret() && (
                  <span className="text-[11px] font-medium text-apple-green">
                    บันทึกแล้ว
                  </span>
                )}
              </div>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={hasExistingSecret() ? '••••••••' : 'Client Secret / App Secret'}
                className="apple-input font-mono text-[12px]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="apple-btn-secondary"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveAndOpenOAuth()}
                className="apple-btn-primary"
              >
                <Link2 className="h-4 w-4" />
                {busy ? 'กำลังเปิด...' : 'เชื่อมต่อ'}
              </button>
            </div>

            {callbackUrl.trim() !== defaultCallbackUrl && (
              <div
                className="space-y-2 border-t pt-3"
                style={{ borderColor: 'var(--separator)' }}
              >
                <label className="block text-[12px] font-medium text-apple-secondary">
                  URL หลัง Login
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={redirectedUrl}
                    onChange={(e) => setRedirectedUrl(e.target.value)}
                    placeholder="https://.../?code=..."
                    className="apple-input font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    disabled={busy || !redirectedUrl.trim()}
                    onClick={() => void handleCompleteRedirectUrl()}
                    className="apple-btn-primary py-2 px-3 text-[12px] shrink-0"
                  >
                    ยืนยัน
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'unified' && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                Base URL
              </label>
              <input
                type="text"
                value={unifiedBaseUrl}
                onChange={(e) => setUnifiedBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="apple-input font-mono text-[12px]"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[12px] font-medium text-apple-secondary">
                  API Key
                </label>
                {settings?.hasUnifiedApiKey && (
                  <span className="text-[11px] font-medium text-apple-green">
                    บันทึกแล้ว
                  </span>
                )}
              </div>
              <input
                type="password"
                value={unifiedApiKey}
                onChange={(e) => setUnifiedApiKey(e.target.value)}
                placeholder={settings?.hasUnifiedApiKey ? '••••••••' : 'API Key'}
                className="apple-input font-mono text-[12px]"
              />
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-apple-secondary">
                Account ID ({account.platform})
              </label>
              <input
                type="text"
                value={unifiedAccountId}
                onChange={(e) => setUnifiedAccountId(e.target.value)}
                placeholder="acc_..."
                className="apple-input font-mono text-[12px]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="apple-btn-secondary"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveUnified()}
                className="apple-btn-primary"
              >
                <Check className="h-4 w-4" />
                {busy ? 'กำลังบันทึก...' : 'เชื่อมต่อ'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
