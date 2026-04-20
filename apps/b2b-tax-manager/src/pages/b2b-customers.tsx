import { useAppBridge } from "@saleor/app-sdk/app-bridge";
import { Box, Text, Button } from "@saleor/macaw-ui";
import { NextPage } from "next";
import { useState } from "react";
import { trpcClient } from "../modules/trpc/trpc-client";

const B2BCustomersPage: NextPage = () => {
  const { appBridgeState } = useAppBridge();

  const [cursor, setCursor] = useState<string | undefined>();
  const { data, isLoading, refetch } = trpcClient.b2bCustomers.list.useQuery({
    first: 20,
    cursor,
  });

  const markAsB2B = trpcClient.b2bCustomers.markAsB2B.useMutation({
    onSuccess: () => refetch(),
  });

  const revokeB2B = trpcClient.b2bCustomers.revokeB2B.useMutation({
    onSuccess: () => refetch(),
  });

  const [showAddForm, setShowAddForm] = useState(false);
  const [newVat, setNewVat] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newCountry, setNewCountry] = useState("");

  if (isLoading) {
    return (
      <Box padding={5}>
        <Text size={7} fontWeight="bold">B2B Customers</Text>
        <Text>Loading...</Text>
      </Box>
    );
  }

  return (
    <Box padding={5} display="flex" flexDirection="column" gap={4}>
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Text size={7} fontWeight="bold">B2B Customers</Text>
        <Button onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Cancel" : "Mark Customer as B2B"}
        </Button>
      </Box>

      {showAddForm && (
        <Box
          padding={4}
          borderWidth={1}
          borderStyle="solid"
          borderColor="default1"
          borderRadius={2}
          display="flex"
          flexDirection="column"
          gap={2}
        >
          <Text size={5} fontWeight="bold">Mark Customer as B2B</Text>
          <input
            placeholder="User ID (e.g. VXNlcjoxMjM=)"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            style={{ padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }}
          />
          <input
            placeholder="VAT Number (e.g. DE123456789)"
            value={newVat}
            onChange={(e) => setNewVat(e.target.value)}
            style={{ padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }}
          />
          <input
            placeholder="Country Code (e.g. DE)"
            value={newCountry}
            onChange={(e) => setNewCountry(e.target.value)}
            style={{ padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }}
          />
          <Button
            onClick={() => {
              markAsB2B.mutate({
                userId: newUserId,
                vatNumber: newVat,
                countryCode: newCountry,
              });
              setShowAddForm(false);
              setNewUserId("");
              setNewVat("");
              setNewCountry("");
            }}
          >
            Validate &amp; Mark as B2B
          </Button>
        </Box>
      )}

      <Box as="table" width="100%">
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px" }}>Email</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Company</th>
            <th style={{ textAlign: "left", padding: "8px" }}>VAT Number</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Status</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Country</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data?.customers.map((customer) => (
            <tr key={customer.id}>
              <td style={{ padding: "8px" }}>{customer.email}</td>
              <td style={{ padding: "8px" }}>{customer.companyName ?? "—"}</td>
              <td style={{ padding: "8px" }}>{customer.vatNumber ?? "—"}</td>
              <td style={{ padding: "8px" }}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontSize: "12px",
                    backgroundColor: customer.vatValidated ? "#dcfce7" : "#fef3c7",
                    color: customer.vatValidated ? "#166534" : "#92400e",
                  }}
                >
                  {customer.vatValidated ? "Verified" : "Pending"}
                </span>
              </td>
              <td style={{ padding: "8px" }}>{customer.country ?? "—"}</td>
              <td style={{ padding: "8px" }}>
                <Button
                  onClick={() => revokeB2B.mutate({ userId: customer.id })}
                >
                  Revoke B2B
                </Button>
              </td>
            </tr>
          ))}
          {(!data?.customers || data.customers.length === 0) && (
            <tr>
              <td colSpan={6} style={{ padding: "16px", textAlign: "center", color: "#999" }}>
                No B2B customers found
              </td>
            </tr>
          )}
        </tbody>
      </Box>

      {data?.pageInfo.hasNextPage && (
        <Box display="flex" justifyContent="center">
          <Button
            onClick={() => setCursor(data.pageInfo.endCursor ?? undefined)}
          >
            Load More
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default B2BCustomersPage;
