import { useAppBridge } from "@saleor/app-sdk/app-bridge";
import { isInIframe } from "@saleor/apps-shared/is-in-iframe";
import { NextPage } from "next";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { useIsMounted } from "usehooks-ts";

const IndexPage: NextPage = () => {
  const { appBridgeState } = useAppBridge();
  const isMounted = useIsMounted();
  const { replace } = useRouter();

  useEffect(() => {
    if (isMounted() && appBridgeState?.ready) {
      replace("/dashboard");
    }
  }, [isMounted, appBridgeState?.ready, replace]);

  if (isInIframe()) {
    return <span>Loading...</span>;
  }

  return (
    <div>
      <h1>Customer Extensions App</h1>
      <p>
        This app provides extended customer features including wishlists and verified product
        reviews.
      </p>
      <h2>Features:</h2>
      <ul>
        <li>Product Reviews - Verified purchase reviews from customers</li>
        <li>Wishlists - Save products for later</li>
        <li>Review Moderation - Dashboard interface for managing customer reviews</li>
      </ul>
      <p>Install this app in your Saleor Dashboard to access the review moderation interface.</p>
    </div>
  );
};

export default IndexPage;
