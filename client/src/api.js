export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: options.signal || AbortSignal.timeout(20000),
    });
  } catch (error) {
    // Do not log request bodies: some endpoints contain CPF or admin credentials.
    console.error("API network failure", {
      path,
      kind: error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
    });
    throw new Error("Sem conexão com o servidor. Tente novamente.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("API request failed", {
      path,
      status: response.status,
      category: data.code || "HTTP_ERROR",
    });
    throw new Error(
      data.error || "Não foi possível concluir. Tente novamente.",
    );
  }
  return data;
}
