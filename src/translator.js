const turndown = require("turndown");
const turndownPluginGfm = require("turndown-plugin-gfm");
const he = require("he");
const cheerio = require("cheerio");
const path = require("path");

function initTurndownService() {
  const turndownService = new turndown({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });

  turndownService.use(turndownPluginGfm.tables);

  // preserve embedded tweets
  turndownService.addRule("tweet", {
    filter: (node) =>
      node.nodeName === "BLOCKQUOTE" &&
      node.getAttribute("class") === "twitter-tweet",
    replacement: (content, node) => "\n\n" + node.outerHTML,
  });

  // preserve embedded codepens
  turndownService.addRule("codepen", {
    filter: (node) => {
      // codepen embed snippets have changed over the years
      // but this series of checks should find the commonalities
      return (
        ["P", "DIV"].includes(node.nodeName) &&
        node.attributes["data-slug-hash"] &&
        node.getAttribute("class") === "codepen"
      );
    },
    replacement: (content, node) => "\n\n" + node.outerHTML,
  });

  // preserve embedded scripts (for tweets, codepens, gists, etc.)
  turndownService.addRule("script", {
    filter: "script",
    replacement: (content, node) => {
      let before = "\n\n";
      if (node.previousSibling && node.previousSibling.nodeName !== "#text") {
        // keep twitter and codepen <script> tags snug with the element above them
        before = "\n";
      }
      const html = node.outerHTML.replace('async=""', "async");
      return before + html + "\n\n";
    },
  });

  // preserve iframes (common for embedded audio/video)
  turndownService.addRule("iframe", {
    filter: "iframe",
    replacement: (content, node) => {
      const html = node.outerHTML.replace(
        'allowfullscreen=""',
        'allow="fullscreen"'
      );
      return "\n\n" + html + "\n\n";
    },
  });

  // convert figure to gallery shortcode
  turndownService.addRule("gallery", {
    filter: "figure",
    replacement: (content, node) => {
      let caption = "";
      let images = [];
      for (const child of node.childNodes) {
        if (child.tagName == "FIGCAPTION") {
          caption = child.textContent;
        } else if (child.tagName == "IMG") {
          let src = child.getAttribute("src");
          let alt = child.getAttribute("alt");
          if (alt.length != 0) {
            alt = `'${he.encode(alt)}`
          }
          images.push(`${src}${alt}`)
        }
      }
      return "\n\n" + `{{< gallery caption="${he.encode(caption)}" images="${images.join('|')}" >}}` + "\n\n";
    },
  });

  return turndownService;
}

function encodeText(text) {
  return text.trim().replace('"', '&quot;');
}

function parseFigureSingle($, node) {
  let image;
  let caption = "";

  let a = node.find('a');
  if (a.length == 0) {
    let img = node.find('img');
    if (img.length > 1) {
      throw "multiple img tag in a single figure";
    }

    image = img;
  } else if (a.length == 1) {
    let img = a.find('img');
    if (img.length > 1) {
      throw "multiple img tag in a single figure";
    }

    let href = a.attr('href');
    let src = img.attr('src');
    if (href != src) {
      throw `Not the same link: a[href] ${href} / img[src] ${src}`;
    }

    image = img;
  } else /*a.length > 1*/ {
    throw "multiple a tag in a single figure";
  }

  caption = image.attr('alt');

  let cap = node.find('figcaption');
  if (cap.length > 1) {
      throw "multiple figcaption tag in a single figure";
  } else {
    cap = $(cap.get(0)).text();
    if (caption.length == 0) {
      caption = cap;
    } else {
      if (cap.length != 0 && cap != caption) {
        throw "alt and figcaption set in a single figure";
      }
    }
  }

  node.remove();
  let url = image.attr('src');
  return [`images/${path.basename(url)}`, encodeText(caption)];
}

function parseFigureMult($, node) {
  let images = [];
  for (const fig of node.find('figure')) {
    let node = $(fig);
    images.push(parseFigureSingle($, node));
  }

  let mainCaption = "";
  let caption = node.first('figcaption');
  if (caption) {
    mainCaption = $(caption).text();
  }

  return [mainCaption, images];
}

function getPostContent(post, turndownService, config) {
  let content = post.encoded[0];

  const $ = cheerio.load(content, null, false)
  
  // remove comments
  $.root().contents().filter(function() { return this.type === 'comment'; }).remove();

  // transforms figures to gallery
  let imageList = [];
  let galleries = [];
  let gallery = {
    "caption": "",
    "images": [],
  };
  function pushGallery() {
    if (gallery.images.length === 0) {
      return;
    }
    galleries.push(gallery);
    gallery = {
      "caption": "",
      "images": [],
    };
  }
  function writeGallery(object, insertFn) {
    pushGallery();

    for (const g of galleries) {
      let images = g.images.map((i) => {
        return `<img src="${i.src}" alt="${he.encode(i.caption)}" />`;
      }).join("\n");
      insertFn.call(object, `<figure>\n<figcaption>${he.encode(g.caption)}</figcaption>\n${images}\n</figure>\n`);
    }
    galleries = [];
  }

  let node;
  for (let el of $.root().children()) {
    node = $(el);
    if (node.hasClass('wp-block-image')) {
      const [url, caption] = parseFigureSingle($, node);
      gallery.images.push({"src": url, "caption": caption});
      imageList.push(url);
      node.remove();
    } else if (node.hasClass('wp-block-gallery')) {
      const [mainCaption, images] = parseFigureMult($, node);
      // push previous gallery
      if (mainCaption.length != 0) {
        pushGallery();
        gallery.caption = mainCaption;
      }
      for (const [url, caption] of images) {
        gallery.images.push({"src": url, "caption": caption});
        imageList.push(url);
      }
      if (mainCaption.length != 0) {
        pushGallery();
      }
      node.remove();
    } else {
      writeGallery(node, node.before);
    }
  }
  // push remaining gallery
  writeGallery($.root(), $.root().appendTo);

  let imageRegexp = content.match(/<img[^>]*>/g);
  if (imageList.length != imageRegexp.length) {
    console.log(`Count images: ${imageList.length} / ${imageRegexp.length}`)
    console.log(imageList)
    console.log("-------")
    console.log(imageRegexp)
  }

  content = $.html();

  // use turndown to convert HTML to Markdown
  content = turndownService.turndown(content);

  return content;
}

exports.initTurndownService = initTurndownService;
exports.getPostContent = getPostContent;
