type ViewTab<Key extends string> = { key: Key; label: string };

const keepTabInView = { block: "nearest", inline: "nearest", container: "nearest" } as const;

export function MockupViewTabs<Key extends string>({ id, label, tabs, active, onChange }: {
  id: string;
  label: string;
  tabs: readonly ViewTab<Key>[];
  active: Key;
  onChange: (key: Key) => void;
}) {
  const nativeFocusgroup = typeof HTMLElement !== "undefined" && Object.hasOwn(HTMLElement.prototype, "focusGroup");

  return (
    <div className="mockup-view-tabs" role="tablist" aria-label={label}
      {...(nativeFocusgroup ? { focusgroup: "tablist nomemory wrap" } : {})}
    >
      {tabs.map(({ key, label: text }, index) => (
        <button
          key={key}
          id={`${id}-tab-${key}`}
          type="button"
          role="tab"
          aria-selected={active === key}
          tabIndex={nativeFocusgroup || active === key ? undefined : -1}
          {...(nativeFocusgroup && active === key ? { focusgroupstart: "" } : {})}
          onClick={() => onChange(key)}
          onFocus={(event) => event.currentTarget.scrollIntoView(keepTabInView)}
          onKeyDown={(event) => {
            let target: number;
            switch (event.key) {
              case "Home": target = 0; break;
              case "End": target = tabs.length - 1; break;
              case "ArrowLeft":
                if (nativeFocusgroup) return;
                target = (index - 1 + tabs.length) % tabs.length;
                break;
              case "ArrowRight":
                if (nativeFocusgroup) return;
                target = (index + 1) % tabs.length;
                break;
              default: return;
            }
            event.preventDefault();
            document.getElementById(`${id}-tab-${tabs[target].key}`)?.focus({ preventScroll: true });
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
