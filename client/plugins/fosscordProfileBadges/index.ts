import definePlugin from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { FluxDispatcher, RestAPI, UserStore, useEffect } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";

const DIRECTORY_STAFF_BADGE_ID = 22;
const STAFF_BADGE_ID = "1";
const refreshBadges = findByCodeLazy("BADGE_DIRECTORY_FETCH_START") as (id: string) => Promise<void>;

async function refreshProfile(id: string) {
    const { body } = await RestAPI.get({ url: `/users/${id}/profile` });
    FluxDispatcher.dispatch({ type: "USER_PROFILE_FETCH_SUCCESS", userProfile: body });
    await refreshBadges(id);
}

export default definePlugin({
    name: "FosscordProfileBadges",
    description: "Lets the badge customization panel reorder and hide this instance's own profile badges.",
    authors: [FosscordAuthor],
    required: true,
    directoryBadgeId: (id: string) => (id === STAFF_BADGE_ID || id.startsWith("staff-role-") ? DIRECTORY_STAFF_BADGE_ID : ["18", "19", "20", "21"].includes(id) ? Number(id) : id),
    isLocalMilestone: (id: number) => [19, 20, 21].includes(id),
    useProgressRefresh(props: { targetUserId?: string; viewingCurrentUserBadges?: boolean }) {
        const id = props.viewingCurrentUserBadges ? UserStore.getCurrentUser()?.id : (props.targetUserId ?? UserStore.getCurrentUser()?.id);
        useEffect(() => {
            if (!id) return;
            const timer = setInterval(() => {
                if (document.visibilityState === "visible") refreshBadges(id).catch(() => {});
            }, 30000);
            return () => clearInterval(timer);
        }, [id]);
    },
    flux: {
        USER_UPDATE(event: { user?: { id: string } }) {
            const id = event.user?.id;
            if (id && id === UserStore.getCurrentUser()?.id) refreshProfile(id).catch(() => {});
        },
    },
    patches: [
        {
            find: "premium_tenure_1_month_v2:1",
            replacement: {
                match: /(function \i\((\i)\)\{let (\i)=\i\[\2\];if\(null!=\3\)return \3;let (\i)=\i\.\$\[\2\.toUpperCase\(\)\];return"number"==typeof \4\?\4:)void 0\}/,
                replace: "$1$self.directoryBadgeId($2)}",
            },
        },
        {
            find: "2026-10-badge-directory-updates",
            replacement: [
                {
                    match: /(\(0,\i\.Jn\)\((\i\.badge_id)\))/g,
                    replace: "$1&&!$self.isLocalMilestone($2)",
                },
                {
                    match: /(function \i\((\i)\)\{)(?=let\{transitionState:\i,onClose:\i,initialBadgeId:)/,
                    replace: "$1$self.useProgressRefresh($2);",
                },
            ],
        },
    ],
});
