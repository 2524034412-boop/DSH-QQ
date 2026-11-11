' Open the sticker-notes page as a standalone app window (silent).'
' /open-stickers launches an Edge --app window; it also focuses an existing one.'
On Error Resume Next

Dim http
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 5000, 15000
http.Open "GET", "http://127.0.0.1:3100/open-stickers", False
http.Send

If Err.Number <> 0 Then
  MsgBox "打不开表情包页：" & vbCrLf & Err.Description & vbCrLf & vbCrLf & "可能是桥接没在运行。", 48, "她的表情包"
End If
