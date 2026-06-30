1. User enters url (e.g. https://filester.si/f/b2ad36e7bb940517)
2. GET Url
3. Use node-html-parser
4. get all divs with class file-item
5. all divs with this class have an onclick with window.location.href='/d/fileSlug' (fileSlug for example can be IEtnJHv)
6. POST https://filester.si/v2/api/public/download for every fileSlug (or filester.me depending on initial url) with file_slug="fileSlug"
   (response example: {"expires_in":1800,"file":"2d2a6e0b-3539-4085-b153-9fde44dee850.svg","name":"Gemini_Generated_Image_pd84p5pd84p5pd84.svg","server":"https://rs2.filester.me","success":true,"token":"32643261366530622d333533392d343038352d623135332d3966646534346465653835307c313738323833383434377c3130342e32382e3136322e3439.dc14219444e1efc2611288dbcb7019ba38ee9d9a14830a3bf12a3726ad3fae26"})
7. Make the user download `https://rs2.filester.me/v2/${file}?token=${token}&download=true&n=${name}`
