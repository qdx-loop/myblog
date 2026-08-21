---
title: '{{ replace .File.ContentBaseName `-` ` ` | title }}'
date: '{{ .Date }}'
weight: {{- $max := 0 -}}
{{- range where site.RegularPages "Section" "posts" -}}
{{- if gt .Weight $max -}}{{- $max = .Weight -}}{{- end -}}
{{- end -}}{{ add $max 1 }}
author: "qdx"
tags: [""]
categories: [""]
description: ""
---