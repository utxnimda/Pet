async function main() {
  const targets = await fetch('http://127.0.0.1:9228/json/list').then(
    (response) => response.json()
  );
  const target = targets.find(
    (item) => item.type === 'page' && item.url.endsWith('/src/index.html')
  );

  if (!target) {
    throw new Error('Pet renderer target was not found on port 9228.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Could not open the CDP socket.')),
      { once: true }
    );
  });

  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: "playManualAction('argue'); true",
        returnByValue: true
      }
    })
  );

  await new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve();
      }
    });
  });

  console.log('Full argument preview started.');
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
