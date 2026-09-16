try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? "4173"}/readyz`,
    { signal: AbortSignal.timeout(3000) },
  );
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
