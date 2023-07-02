const turndown = require("turndown");
const turndownPluginGfm = require("turndown-plugin-gfm");
const he = require("he");

function upTo(el, tagName) {
  tagName = tagName.toLowerCase();

  while (el && el.parentNode) {
    el = el.parentNode;
    if (el.tagName && el.tagName.toLowerCase() == tagName) {
      return el;
    }
  }

  // Many DOM methods return null if they don't
  // find the element they are searching for
  // It would be OK to omit the following and just
  // return undefined
  return null;
}

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
        "allowfullscreen"
      );
      return "\n\n" + html + "\n\n";
    },
  });

  turndownService.remove("figcaption");

  getImages = function (node) {
    let imgs = {};
    Array.from(node.getElementsByTagName("img")).forEach(function (i) {
      imgs[i.getAttribute("src").toString()] = i.getAttribute("alt").toString();
    });
    return imgs;
  };
  getCaption = function (node) {
    let caption = "";
    Array.from(node.getElementsByTagName("figcaption")).forEach(function (c) {
      caption += c.textContent;
    });
    return caption;
  };
  turndownService.addRule("caption", {
    filter: "figure",
    replacement: (content, node) => {
      //console.log("=====");
      //parent = upTo(node, "figure");
      //console.log(parent.tagName);
      //const html = node.outerHTML.replace('allowfullscreen=""', 'allowfullscreen');
      //return '\n\n' + html + '\n\n';

      let mainCaption = he.encode(getCaption(node));

      let imgs = {};
      Array.from(node.getElementsByTagName("figure")).forEach(function (f) {
        let currentImgs = getImages(f);
        let keys = Object.keys(currentImgs);
        if (keys.length == 0 && keys.length > 1) {
          console.log("error: too much images in figure");
          return;
        }
        if (keys[0] in turndownService.images) {
          return;
        }

        imgs[keys[0]] = getCaption(f) || currentImgs[keys[0]];
        //console.log(`== ${keys[0]} ==`);
      });
      for (let [key, value] of Object.entries(getImages(node))) {
        if (key in turndownService.images) {
          continue;
        }
        if (key in imgs) {
          continue;
        }
        imgs[key] = value;
      }

      let imgList = "";
      for (let [key, value] of Object.entries(imgs)) {
        turndownService.images.push(key);
        imgList += key;
        if (value) imgList += "'" + he.encode(value);
        imgList += "|";
      }
      imgList = imgList.substring(0, imgList.length - 1);
      if (imgList.length == 0) {
        return "";
      }
      //console.log("===" + mainCaption + "===");

      return `\n\n{{< gallery caption="${mainCaption}" images="${imgList}" >}}\n\n`;
    },
  });

  turndownService.addRule("img", {
    filter: "img",
    replacement: (content, node) => {
      function ImgResult(node) {
        this.str = turndownService.turndown(node);
        this.img = node.getAttribute("src");
      }
      ImgResult.prototype.toString = function () {
        return this.str;
      };
      return new ImgResult(node);
    },
  });

  return turndownService;
}

function getPostContent(post, turndownService, config) {
  let content = post.encoded[0];

  // insert an empty div element between double line breaks
  // this nifty trick causes turndown to keep adjacent paragraphs separated
  // without mucking up content inside of other elemnts (like <code> blocks)
  content = content.replace(/(\r?\n){2}/g, "\n<div></div>\n");

  if (config.saveScrapedImages) {
    // writeImageFile() will save all content images to a relative /images
    // folder so update references in post content to match
    content = content.replace(
      /(<img[^>]*src=").*?([^/"]+\.(?:gif|jpe?g|png))("[^>]*>)/gi,
      "$1images/$2$3"
    );
  }

  // this is a hack to make <iframe> nodes non-empty by inserting a "." which
  // allows the iframe rule declared in initTurndownService() to take effect
  // (using turndown's blankRule() and keep() solution did not work for me)
  content = content.replace(/(<\/iframe>)/gi, ".$1");

  // use turndown to convert HTML to Markdown
  turndownService.images = [];
  content = turndownService.turndown(content);
  console.log(turndownService.images);

  // clean up extra spaces in list items
  content = content.replace(/(-|\d+\.) +/g, "$1 ");

  // clean up the "." from the iframe hack above
  content = content.replace(/\.(<\/iframe>)/gi, "$1");

  return content;
}

exports.initTurndownService = initTurndownService;
exports.getPostContent = getPostContent;
