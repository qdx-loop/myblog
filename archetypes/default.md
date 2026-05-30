+++

date = '{{ .Date }}'

draft = false

title = '{{ replace .File.ContentBaseName "-" " " | title }}'

categories = \[""]

tags = \[""]

series = \[""]



\# 封面图配置（可选，留空就不显示）

cover = {

&#x20; image = "images/",

&#x20; caption = "",

&#x20; alt = "图片加载失败",

&#x20; relative = false

}

+++

