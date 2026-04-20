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
      replace("/b2b-customers");
    }
  }, [isMounted, appBridgeState?.ready, replace]);

  if (isInIframe()) {
    return <p>Loading</p>;
  }

  return (
    <div>
      <h1>B2B Tax Manager</h1>
      <p>Saleor App for B2B VAT validation, tax exemption, and reverse charge management.</p>
      <p>Install in your Saleor instance and open from Dashboard.</p>
    </div>
  );
};

export default IndexPage;
