function onGmailMessageOpen(event) {
  var subject = messageSubject(event);
  var threadId = event && event.gmail && event.gmail.threadId ? event.gmail.threadId : "";
  var link = threadId ? "https://mail.google.com/mail/u/0/#inbox/" + threadId : "";
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle("KeepX"))
    .addSection(
      CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(subject))
        .addWidget(
          CardService.newTextButton()
            .setText("Save to KeepX")
            .setOnClickAction(
              CardService.newAction().setFunctionName("saveMessage").setParameters({
                subject: subject.slice(0, 500),
                link: link.slice(0, 2000),
              }),
            ),
        ),
    )
    .build();
}

function messageSubject(event) {
  try {
    var id = event.gmail.messageId;
    var token = event.gmail.accessToken;
    var response = UrlFetchApp.fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
        encodeURIComponent(id) +
        "?format=metadata&metadataHeaders=Subject",
      { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true },
    );
    if (response.getResponseCode() !== 200) return "Email";
    var data = JSON.parse(response.getContentText());
    var headers = data.payload && data.payload.headers ? data.payload.headers : [];
    for (var i = 0; i < headers.length; i += 1) {
      if (headers[i].name === "Subject" && headers[i].value) return String(headers[i].value);
    }
  } catch (error) {
    return "Email";
  }
  return "Email";
}

function saveMessage(event) {
  var props = PropertiesService.getUserProperties();
  var base = String(props.getProperty("KEEPX_BASE") || "").replace(/\/$/, "");
  var token = props.getProperty("KEEPX_TOKEN") || "";
  if (!base || !token) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText("Set KEEPX_BASE and KEEPX_TOKEN in the script properties."))
      .build();
  }
  var subject = (event.parameters && event.parameters.subject) || "Email";
  var link = (event.parameters && event.parameters.link) || "";
  var response = UrlFetchApp.fetch(base + "/api/v1/tasks", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ title: subject, description: link }),
    muteHttpExceptions: true,
  });
  var ok = response.getResponseCode() === 201;
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(ok ? "Saved to KeepX." : "KeepX rejected the request."))
    .build();
}
