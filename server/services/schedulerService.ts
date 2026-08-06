import cron from "node-cron";
import { Post } from "../models/Post.js";
import { Account } from "../models/Account.js";
import zernio from "../config/zernio.js";
import { ActivityLog } from "../models/ActivityLog.js";


export const initScheduler = () =>{
    cron.schedule("* * * * *", async ()=>{
        try {
           const now = new Date();
           const postsToPublish = await Post.find({status: "scheduled", scheduledFor: {$lte: now}});

           for(const post of postsToPublish){
            try {
                const accounts = await Account.find({
                    user: post.user,
                    platform: {$in: post.platforms},
                    status: "connected",
                    zernioAccountId: {$exists: true}
                })
                if(accounts.length === 0){
                    console.log(`No connected Zernio accounts found for post ${post._id}`);
                    continue;
                }
                const zernioPlatforms = accounts.map((acc)=>({
                    platform: acc.platform as any,
                    accountId: acc.zernioAccountId!
                }))

                const payload = {
                    content: post.content,
                    publishNow: true,
...(post.mediaUrl ? {mediaItems: [{type: post.mediaType || "image", url: post.mediaUrl}]} : {}),
                    platforms: zernioPlatforms,
                }

                console.log(`Publishing post ${post._id} to Zernio with media: ${post.mediaUrl || "none"}`)

                const response = await zernio.posts.createPost({
                    body: payload
                })

                const publishedPost = (response.data as any)?.post || response.data;

                if(!publishedPost){
                    throw new Error("Failed to get post object from zernio response")
                }

                const zernioPostId = publishedPost._id || publishedPost.id;
                console.log(`Zernio post created: ${zernioPostId} (status: ${publishedPost.status || "unknown"})`);

                // Determine the actual Zernio post status. With publishNow:true Zernio may
                // return "publishing" (async) rather than "published" immediately, so we
                // poll until we reach a terminal state before marking the local post.
                const zernioStatus = String(publishedPost.status || "publishing").toLowerCase();

                let finalStatus = zernioStatus;
                if (zernioStatus === "publishing" || zernioStatus === "scheduled") {
                    // Poll getPost for up to ~5 minutes until terminal.
                    const deadline = Date.now() + 5 * 60 * 1000;
                    while (Date.now() < deadline) {
                        await new Promise((r) => setTimeout(r, 5000));
                        let current = zernioStatus;
                        try {
                            const pollResp = await zernio.posts.getPost({
                                path: { postId: zernioPostId },
                            });
                            const polled = (pollResp.data as any)?.post || pollResp.data;
                            current = String(polled?.status || current).toLowerCase();
                        } catch (pollErr: any) {
                            console.warn(`Polling post ${zernioPostId} failed (continuing):`, pollErr?.message || pollErr);
                            break;
                        }
                        finalStatus = current;
                        if (current === "published" || current === "partial" || current === "failed") {
                            break;
                        }
                    }
                }

                if (finalStatus === "published" || finalStatus === "partial") {
                    post.status = "published";
                    await post.save();

                    await ActivityLog.create({
                        user: post.user,
                        actionType: "POST_PUBLISHED",
                        description: `Published post to ${accounts.map((a) => a.platform).join(", ")}`,
                        relatedPost: post._id,
                    })
                } else if (finalStatus === "failed") {
                    post.status = "failed";
                    await post.save();
                } else {
                    // Still publishing/scheduled on Zernio after the poll window.
                    // Leave it as "scheduled" so a later run attempts it again.
                    console.warn(`Zernio post ${zernioPostId} did not reach a terminal state (status: ${finalStatus}). Keeping post scheduled.`);
}
} catch (err: any) {
                // The Zernio SDK throws a ZernioApiError whose status is exposed on
                // `err.statusCode` (not `err.status`). Read it from all possible places.
                const statusCode = err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.code;
                const errMsg = err?.response?.data?.message || err?.details?.message || err?.message || err;

                // 403/401 = permission/authentication error (e.g. invalid Zernio token or
                // platform not authorized). This is NOT a terminal failure of the post —
                // it's an account/config problem. Keep the post "scheduled" so it stays
                // in the "Upcoming" queue and can retry after the account is fixed.
                if (statusCode === 403 || statusCode === 401) {
                    console.warn(`Publish post ${post._id} blocked (${statusCode}): ${errMsg}. Keeping post scheduled.`);
                    continue;
                }

                // Instagram requires media (image/video). This is a content problem, not a
                // transient failure — keep the post "scheduled" so it stays visible in the
                // "Upcoming" queue instead of silently moving to "failed".
                const isInstagramMediaRequirement =
                    String(errMsg).toLowerCase().includes("instagram") &&
                    (String(errMsg).toLowerCase().includes("media") || String(errMsg).toLowerCase().includes("image") || String(errMsg).toLowerCase().includes("video"));

                if (statusCode === 400 && isInstagramMediaRequirement) {
                    console.warn(`Publish post ${post._id} needs media for Instagram: ${errMsg}. Keeping post scheduled.`);
                    continue;
                }

                console.error(`Failed to publish post ${post._id} :`, err?.response?.data || err?.message);
                post.status = "failed";
                await post.save();
                
            }
           }
           if(postsToPublish.length > 0){
            console.log(`Evaluated ${postsToPublish.length} posts at ${now.toISOString()}`);
           }
        } catch (error) {
            console.error("Error in scheduler:", error);
            
        }
    })
    console.log("Scheduler service initialized");
}