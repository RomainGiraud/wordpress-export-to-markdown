const fs = require("fs");
const path = require("path");
const luxon = require("luxon");
const xml2js = require("xml2js");
const nodersa = require('node-rsa')

const shared = require("./shared");
const settings = require("./settings");
const translator = require("./translator");

async function parseFilePromise(config) {
  console.log("\nParsing...");
  const content = await fs.promises.readFile(config.input, "utf8");
  const data = await xml2js.parseStringPromise(content, {
    trim: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });

  const postTypes = getPostTypes(data, config);
  const posts = collectPosts(data, postTypes, config);

  const images = [];
  if (config.saveAttachedImages) {
    images.push(...collectAttachedImages(data));
  }
  if (config.saveScrapedImages) {
    images.push(...collectScrapedImages(data, postTypes));
  }

  mergeImagesIntoPosts(images, posts);
  cleanImages(posts, config);

  return posts;
}

function encrypt(value, keyFile) {
  let rsa = new nodersa();
  let key = fs.readFileSync(keyFile, 'utf8');
  rsa.importKey(key, 'pkcs1-public-pem');
  return rsa.encrypt(value, 'base64', 'utf-8')
}

function getComments(post, config) {
  return post.comment
    .filter(comment => comment.comment_approved[0] == "1")
    .map((comment) => {
      return {
        "_id": comment.comment_id[0],
        "_parent": comment.comment_parent[0],
        "message": comment.comment_content[0],
        "name": comment.comment_author[0],
        "email": comment.comment_author_email[0],
        "date": getCommentDate(comment.comment_date[0]),
      };
    })
    .map((comment) => {
      if (config.commentKeysToEncrypt.length == 0) {
        return comment;
      }

      for (const k in comment) {
        if (config.commentKeysToEncrypt.includes(k)) {
          comment[k] = encrypt(comment[k], config.publicKey)
        }
      }
      return comment;
    });
}

function getPostTypes(data, config) {
  if (config.includeOtherTypes) {
    // search export file for all post types minus some default types we don't want
    // effectively this will be 'post', 'page', and custom post types
    const types = data.rss.channel[0].item
      .map((item) => item.post_type[0])
      .filter(
        (type) =>
          ![
            "attachment",
            "revision",
            "nav_menu_item",
            "custom_css",
            "customize_changeset",
          ].includes(type)
      );
    return [...new Set(types)]; // remove duplicates
  } else {
    // just plain old vanilla "post" posts
    return ["post"];
  }
}

function getItemsOfType(data, type) {
  return data.rss.channel[0].item.filter((item) => item.post_type[0] === type);
}

function collectPosts(data, postTypes, config) {
  // this is passed into getPostContent() for the markdown conversion
  const turndownService = translator.initTurndownService();

  let allPosts = [];
  postTypes.forEach((postType) => {
    const postsForType = getItemsOfType(data, postType)
      .filter(
        (post) => post.status[0] !== "trash" && post.status[0] !== "draft"
      )
      .filter(
        (post) => (config.onlyPosts.length != 0 ? config.onlyPosts.includes(getPostId(post)) : true)
      )
      .map((post) => ({
        comments: getComments(post, config),
        // meta data isn't written to file, but is used to help with other things
        meta: {
          id: getPostId(post),
          slug: getPostSlug(post),
          coverImageId: getPostCoverImageId(post),
          type: postType,
          imageUrls: [],
        },
        frontmatter: {
          title: getPostTitle(post),
          date: getPostDate(post),
          old_url: getPostLink(post),
          categories: getCategories(post),
          tags: getTags(post),
        },
        content: translator.getPostContent(post, turndownService, config),
      }));

    if (postTypes.length > 1) {
      console.log(`${postsForType.length} "${postType}" posts found.`);
    }

    allPosts.push(...postsForType);
  });

  if (postTypes.length === 1) {
    console.log(allPosts.length + " posts found.");
  }
  return allPosts;
}

function getPostId(post) {
  return post.post_id[0];
}

function getPostSlug(post) {
  return decodeURIComponent(post.post_name[0]);
}

function getPostCoverImageId(post) {
  if (post.postmeta === undefined) {
    return undefined;
  }

  const postmeta = post.postmeta.find(
    (postmeta) => postmeta.meta_key[0] === "_thumbnail_id"
  );
  const id = postmeta ? postmeta.meta_value[0] : undefined;
  return id;
}

function getPostTitle(post) {
  return post.title[0];
}

function getCommentDate(date) {
  const zone = settings.local_date ? "local" : "utc";
  const dateTime = luxon.DateTime.fromFormat(date, "yyyy-MM-dd HH:mm:ss", { zone: zone });

  if (settings.custom_date_formatting) {
    return dateTime.toFormat(settings.custom_date_formatting);
  } else if (settings.include_time_with_date) {
    return dateTime.toISO();
  } else {
    return dateTime.toISODate();
  }
}

function getPostDate(post) {
  const zone = settings.local_date ? "local" : "utc";
  const dateTime = luxon.DateTime.fromRFC2822(post.pubDate[0], { zone: zone });

  if (settings.custom_date_formatting) {
    return dateTime.toFormat(settings.custom_date_formatting);
  } else if (settings.include_time_with_date) {
    return dateTime.toISO();
  } else {
    return dateTime.toISODate();
  }
}

function getPostLink(post) {
  return post.link[0];
}

function getCategories(post) {
  const categories = processCategoryTags(post, "category");
  return categories.filter(
    (category) => !settings.filter_categories.includes(category)
  );
}

function getTags(post) {
  return processCategoryTags(post, "post_tag");
}

function processCategoryTags(post, domain) {
  if (!post.category) {
    return [];
  }

  return post.category
    .filter((category) => category.$.domain === domain)
    .map(({ $: attributes }) => decodeURIComponent(attributes.nicename));
}

function collectAttachedImages(data) {
  const images = getItemsOfType(data, "attachment")
    // filter to certain image file types
    .filter((attachment) =>
      /\.(gif|jpe?g|png)$/i.test(attachment.attachment_url[0])
    )
    .map((attachment) => ({
      id: attachment.post_id[0],
      postId: attachment.post_parent[0],
      url: attachment.attachment_url[0],
    }));

  console.log(images.length + " attached images found.");
  return images;
}

function collectScrapedImages(data, postTypes) {
  const images = [];
  postTypes.forEach((postType) => {
    getItemsOfType(data, postType).forEach((post) => {
      const postId = post.post_id[0];
      const postContent = post.encoded[0];
      const postLink = post.link[0];

      const matches = [
        ...postContent.matchAll(
          /<img[^>]*src="(.+?\.(?:gif|jpe?g|png))"[^>]*>/gi
        ),
      ];
      matches.forEach((match) => {
        // base the matched image URL relative to the post URL
        const url = new URL(match[1], postLink).href;
        images.push({
          id: -1,
          postId: postId,
          url,
        });
      });
    });
  });

  console.log(images.length + " images scraped from post body content.");
  return images;
}

function mergeImagesIntoPosts(images, posts) {
  images.forEach((image) => {
    posts.forEach((post) => {
      let shouldAttach = false;

      // this image was uploaded as an attachment to this post
      if (image.postId === post.meta.id) {
        shouldAttach = true;
      }

      // this image was set as the featured image for this post
      if (image.id === post.meta.coverImageId) {
        shouldAttach = true;
        post.frontmatter.featured_image =
          "images/" + shared.getFilenameFromUrl(image.url);
      }

      if (shouldAttach && !post.meta.imageUrls.includes(image.url)) {
        post.meta.imageUrls.push(image.url);
      }
    });
  });
}

function cleanImages(posts, config) {
  if (config.imagesFromFolder.length == 0) {
    console.warn("Cannot cleanImages by URL")
    return;
  }

  const patterns = [
    /-[0-9]+x[0-9]+\./,
    /-scaled\./,
  ];
  posts.forEach((post) => {
    post.meta.imageUrls = post.meta.imageUrls.map((imageUrl) => {
      let newUrl = imageUrl;
      patterns.forEach((pattern) => {
        const dirname = path.dirname(newUrl);
        const filename = path.basename(newUrl);
        const newFilename = filename.replace(pattern, ".");
        const tmp = path.join(dirname, newFilename);
        if (filename != newFilename) {
          post.content = post.content.replace(filename, newFilename);
          if (path.basename(post.frontmatter.featured_image) == filename) {
            post.frontmatter.featured_image = post.frontmatter.featured_image.replace(filename, newFilename);
          }
        }
        newUrl = tmp;
      });
      return newUrl;
    });
  });
}

exports.parseFilePromise = parseFilePromise;
