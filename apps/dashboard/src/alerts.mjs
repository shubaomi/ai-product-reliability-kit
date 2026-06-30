export async function deliverAlert(store, alert, context, config) {
  const message = `[${alert.severity ?? "medium"}] ${alert.name}: ${alert.action ?? alert.condition}`;
  const deliveries = [];

  deliveries.push(await deliverConsole(store, alert, context, message));

  if (config.alertWebhookUrl) {
    deliveries.push(await deliverWebhook(store, alert, context, message, config.alertWebhookUrl, "webhook"));
  }

  if (config.alertFeishuWebhookUrl) {
    deliveries.push(await deliverWebhook(store, alert, context, message, config.alertFeishuWebhookUrl, "feishu"));
  }

  return deliveries;
}

async function deliverConsole(store, alert, context, message) {
  const delivery = {
    alert_id: alert.id,
    product_id: alert.product_id ?? context.product_id,
    channel: "console",
    status: "sent",
    message,
    response: { printed: true }
  };
  console.warn(message);
  await store.appendAlertDelivery(delivery);
  return delivery;
}

async function deliverWebhook(store, alert, context, message, url, channel) {
  const payload = { alert, context, message, delivered_at: new Date().toISOString() };
  let status = "sent";
  let responsePayload = {};
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    responsePayload = { status: response.status };
    if (!response.ok) status = "failed";
  } catch (error) {
    status = "failed";
    responsePayload = { error: error.message };
  }
  const delivery = {
    alert_id: alert.id,
    product_id: alert.product_id ?? context.product_id,
    channel,
    status,
    message,
    response: responsePayload
  };
  await store.appendAlertDelivery(delivery);
  return delivery;
}

