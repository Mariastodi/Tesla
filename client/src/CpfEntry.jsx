export const digits = (value) =>
  String(value || "")
    .replace(/\D/g, "")
    .slice(0, 11);
export const maskCpf = (value) => {
  let i = 0;
  return "___.___.___-__".replace(/_/g, () => value[i++] || "_");
};
export function CpfEntry({
  value,
  onChange,
  onCancel,
  onConfirm,
  busy,
  disabled,
  label = "Confirmar presença",
}) {
  return (
    <section className="entry" aria-label="Entrada de CPF">
      <label className="sr-only" htmlFor="cpf">
        Digite seu CPF
      </label>
      <input
        id="cpf"
        className="cpf-display"
        inputMode="none"
        autoComplete="off"
        spellCheck={false}
        value={maskCpf(value)}
        readOnly
        aria-label="CPF"
      />
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => (
          <button
            className="key"
            key={key}
            disabled={busy}
            onClick={() => onChange(digits(value + key))}
          >
            {key}
          </button>
        ))}
        <button
          className="key action"
          disabled={busy}
          aria-label="Apagar último número"
          onClick={() => onChange(value.slice(0, -1))}
        >
          ⌫
        </button>
        <button
          className="key"
          disabled={busy}
          onClick={() => onChange(digits(value + "0"))}
        >
          0
        </button>
        <button className="key action" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
      <button
        className="confirm-button"
        onClick={onConfirm}
        disabled={busy || disabled || value.length !== 11}
      >
        {busy ? "Conferindo…" : label}
        <span aria-hidden="true">→</span>
      </button>
    </section>
  );
}
