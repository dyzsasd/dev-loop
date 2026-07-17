{{- define "dev-loop.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dev-loop.labels" -}}
app.kubernetes.io/name: dev-loop
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "dev-loop.selectorLabels" -}}
app: dev-loop
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
