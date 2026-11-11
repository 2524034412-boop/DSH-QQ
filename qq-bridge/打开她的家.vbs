' Open "her home" as a standalone app window (silent: no browser tab, no console flash).
' The bridge endpoint /open-space launches an Edge --app window and focuses it if already open.
On Error Resume Next

Dim http
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 5000, 15000
http.Open "GET", "http://127.0.0.1:3100/open-space", False
http.Send

If Err.Number <> 0 Then
  MsgBox "打不开她的家：" & vbCrLf & Err.Description & vbCrLf & vbCrLf & "可能是桥接没在运行。", 48, "她的家"
End If