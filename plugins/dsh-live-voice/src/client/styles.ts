const CSS = `
.dsh-kokoro-voice-button,.dsh-kokoro-actions button{display:grid;place-items:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);cursor:pointer;border-radius:8px}.dsh-kokoro-voice-button{width:30px;height:30px}.dsh-kokoro-voice-button:hover,.dsh-kokoro-voice-button.is-active{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-background-hover,rgba(255,255,255,.08))}.dsh-kokoro-voice-button svg,.dsh-kokoro-actions svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.dsh-kokoro-overlay{position:fixed;right:28px;bottom:28px;z-index:1000;width:164px;padding:16px 14px 12px;border:1px solid rgba(255,255,255,.13);border-radius:22px;background:rgba(28,28,30,.9);box-shadow:0 16px 48px rgba(0,0,0,.35);backdrop-filter:blur(22px);display:flex;flex-direction:column;align-items:center;gap:10px}.dsh-kokoro-orb{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 38% 32%,#fff 0,#d7d9dc 28%,#777b83 70%,#34363b 100%);box-shadow:0 0 0 7px rgba(255,255,255,.05)}.dsh-kokoro-orb span{width:19px;height:19px;border-radius:50%;background:rgba(255,255,255,.75);filter:blur(1px)}.dsh-kokoro-overlay.phase-listening .dsh-kokoro-orb,.dsh-kokoro-overlay.phase-hearing .dsh-kokoro-orb{animation:dsh-kokoro-pulse 1.5s ease-in-out infinite}.dsh-kokoro-overlay.phase-thinking .dsh-kokoro-orb{box-shadow:0 0 0 8px rgba(76,135,255,.12),0 0 24px rgba(76,135,255,.2)}.dsh-kokoro-overlay.phase-speaking .dsh-kokoro-orb{animation:dsh-kokoro-speak .65s ease-in-out infinite alternate}.dsh-kokoro-status{font-size:12px;color:#d3d3d6;max-width:142px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-kokoro-actions{display:flex;gap:8px}.dsh-kokoro-actions button{width:30px;height:30px;background:rgba(255,255,255,.07);color:#ddd}.dsh-kokoro-actions button:hover{background:rgba(255,255,255,.14)}.dsh-kokoro-actions button.is-end{color:#ff7777}.dsh-kokoro-actions svg rect{fill:currentColor;stroke:none}@keyframes dsh-kokoro-pulse{50%{box-shadow:0 0 0 12px rgba(255,255,255,.025)}}@keyframes dsh-kokoro-speak{to{transform:scale(1.06)}}@media(prefers-reduced-motion:reduce){.dsh-kokoro-orb{animation:none!important}}
.dsh-live-voice-settings{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);padding:0 4px 24px;max-width:720px}.dsh-live-voice-settings__hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.dsh-live-voice-settings__title{margin:0;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.02em}.dsh-live-voice-settings__intro{max-width:560px;margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}.dsh-live-voice-settings__summary{flex:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-1);border-radius:999px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}.dsh-live-voice-settings__group{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-1);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}.dsh-live-voice-settings__group-title{margin:0;padding:15px 16px 3px;font-size:15px;line-height:22px;font-weight:600}.dsh-live-voice-settings__group-description{margin:0;padding:0 16px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dsh-live-voice-settings__row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:62px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-1)}.dsh-live-voice-settings__copy{min-width:0;flex:1}.dsh-live-voice-settings__label{font-size:13px;font-weight:550;line-height:20px}.dsh-live-voice-settings__description{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dsh-live-voice-settings__control{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:10px;min-width:190px}.dsh-live-voice-settings__select{box-sizing:border-box;width:190px;height:36px;border:1px solid var(--dsw-alias-border-1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:12px;outline:none}.dsh-live-voice-settings__select:focus{border-color:var(--dsw-alias-border-primary)}.dsh-live-voice-settings__select:disabled{opacity:.5;cursor:not-allowed}.dsh-live-voice-settings__range{display:flex;align-items:center;gap:10px;width:250px}.dsh-live-voice-settings__range input{width:180px;accent-color:var(--dsw-alias-brand-primary,#4c78ff)}.dsh-live-voice-settings__range output{min-width:58px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}.dsh-live-voice-settings__value{color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right}.dsh-live-voice-settings__error{margin:0 4px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,#e5484d 12%,transparent);color:#d33;font-size:12px;line-height:18px}.dsh-live-voice-settings__notice{margin:0 4px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}@media(max-width:700px){.dsh-live-voice-settings__row{align-items:flex-start;flex-direction:column;gap:8px}.dsh-live-voice-settings__control{width:100%;justify-content:flex-start}.dsh-live-voice-settings__range{width:100%}.dsh-live-voice-settings__range input{flex:1}.dsh-live-voice-settings__select{width:100%}}

@media (display-mode: standalone) and (max-width: 700px) {
  [class*="_sidebarCol"],
  [class*="_centerCol"] {
    box-shadow: none !important;
    filter: none !important;
  }
  [class*="_sidebarCol"] {
    border-right: 0 !important;
  }
  [class*="_sidebarCol"]::before,
  [class*="_sidebarCol"]::after,
  [class*="_centerCol"]::before,
  [class*="_centerCol"]::after,
  button[aria-label*="sidebar" i],
  button[aria-label*="menu" i] {
    box-shadow: none !important;
    filter: none !important;
    text-shadow: none !important;
  }
}
`

export function installStyles(): () => void {
  const id = 'dsh-live-voice-kokoro-styles'
  const existing = document.getElementById(id)
  if (existing) return () => undefined
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.append(style)
  return () => style.remove()
}
