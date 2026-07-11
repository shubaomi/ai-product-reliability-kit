export async function deliverAlert(store, rule, context, config = {}, options = {}) {
  const notificationType = options.notificationType ?? "alert";
  const prefix = notificationType === "recovery" ? "RECOVERED" : String(rule.severity ?? "medium").toUpperCase();
  const message = `[${prefix}] ${rule.name}: ${notificationType === "recovery" ? "signal recovered" : rule.action ?? rule.type}`;
  const deliveries = [];

  deliveries.push(await deliverConsole(store, rule, context, message, notificationType, options.now));
  if (config.alertWebhookUrl) {
    deliveries.push(await deliverWebhook(store, rule, context, message, config.alertWebhookUrl, "webhook", notificationType, options));
  }
  if (config.alertFeishuWebhookUrl) {
    deliveries.push(await deliverWebhook(store, rule, context, message, config.alertFeishuWebhookUrl, "feishu", notificationType, options));
  }
  return deliveries;
}

async function deliverConsole(store, rule, context, message, notificationType, now = new Date()) {
  const delivery = deliveryRecord(rule, context, {
    channel: "console",
    status: "sent",
    message,
    notification_type: notificationType,
    delivered_at: new Date(now).toISOString(),
    response: { printed: true }
  });
  console.warn(message);
  await store.appendAlertDelivery(delivery);
  return delivery;
}

async function deliverWebhook(store, rule, context, message, url, channel, notificationType, options) {
  const deliveredAt = new Date(options.now ?? Date.now()).toISOString();
  const payload = {
    rule: { id: rule.id, type: rule.type, product_id: rule.product_id, environment: rule.environment, severity: rule.severity },
    alert: context.instance,
    evaluation: context.evaluation,
    notification_type: notificationType,
    message,
    delivered_at: deliveredAt
  };
  let status = "sent";
  let responsePayload = {};
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
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
  const delivery = deliveryRecord(rule, context, {
    channel,
    status,
    message,
    notification_type: notificationType,
    delivered_at: deliveredAt,
    response: responsePayload
  });
  await store.appendAlertDelivery(delivery);
  return delivery;
}

function deliveryRecord(rule, context, values) {
  return {
    alert_id: rule.id,
    product_id: rule.product_id,
    environment: rule.environment ?? "production",
    dedup_key: context.instance?.dedup_key ?? context.evaluation?.dedupKey,
    ...values
  };
}
