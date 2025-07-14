// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);

const serviceAccount = require("./firebase_admin_key.json");

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB client setup
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Middleware: Verify Firebase Token
const verifyFbToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized Access: No token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;

    next();
  } catch (error) {
    return res.status(403).json({ message: "Forbidden: Invalid token" });
  }
};

// Middleware: Verify email matches decoded token email
const verifyEmail = (req, res, next) => {
  try {
    if (req.decoded.email === req.query.email) {
      next();
    } else {
      res.status(403).json({ message: "Forbidden: Email mismatch" });
    }
  } catch {
    res.status(500).json({ message: "Internal Server Error" });
  }
};
let usersCollection, ridersCollection, parcelCollection, paymentCollection;

const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  const user = await usersCollection.findOne({ email });
  if (user?.role === "admin") {
    next();
  } else {
    res.status(403).json({ message: "Forbidden: Admin only" });
  }
};

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();
    const db = client.db("fast-track");
    usersCollection = db.collection("users");
    ridersCollection = db.collection("riders");
    parcelCollection = db.collection("parcel");
    paymentCollection = db.collection("payments");

    // ===================== USERS =====================
    app.post("/users", async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ message: "User already exists" });
      }
      const result = await usersCollection.insertOne(req.body);
      res.status(201).json(result);
    });

    app.get("/users", verifyFbToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.delete("/users/:id", verifyFbToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user ID" });
      }

      const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
      res.json(result);
    });

    app.patch(
      "/users/updateProfile",
      verifyFbToken,
      verifyEmail,
      async (req, res) => {
        const email = req.query.email;
        const filter = { email: email };
        const { name, photo } = req.body;

        const updateDoc = {
          $set: { name: name, photoUrl: photo },
        };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );
    // ===================== updating user role =====================
    app.patch("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const { role } = req.body;
      if (!role) {
        return res.status(400).json({ message: "Role is required" });
      }

      try {
        const result = await usersCollection.updateOne(
          { email },
          { $set: { role } }
        );
        res.json(result);
      } catch (error) {
        console.error("Error updating role:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // ===================== Find a user admin or not =====================
    app.get(
      "/users/admin-check",
      verifyFbToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.query.email;
        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }
        try {
          const result = await usersCollection.findOne({ email });
          res.send({ isAdmin: result?.role === "admin" });
        } catch (error) {
          res.status(500).send({ message: "failed to check admin status" });
        }
      }
    );
    // ===================== RIDERS =====================
    app.post("/riders", async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      try {
        const existingRider = await ridersCollection.findOne({ email });
        if (existingRider) {
          return res.status(409).json({ message: "Rider already exists" });
        }

        const result = await ridersCollection.insertOne(req.body);
        res.status(201).json(result);
      } catch (error) {
        console.error("Error adding rider:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    app.get("/riders/pending", verifyFbToken, verifyAdmin, async (req, res) => {
      try {
        const status = { status: "pending" };
        const riders = await ridersCollection.find(status).toArray();
        res.json(riders);
      } catch (error) {
        res.status(500).json({ message: "Server error fetching riders" });
      }
    });
    app.get("/riders/active", verifyFbToken, verifyAdmin, async (req, res) => {
      const riders = await ridersCollection
        .find({ status: "accepted" })
        .toArray();
      res.send(riders);
    });

    app.patch("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid rider ID" });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status } };

      try {
        const result = await ridersCollection.updateOne(filter, updateDoc);

        let roleUpdateResult = null;
        if (status === "accepted" && email) {
          roleUpdateResult = await usersCollection.updateOne(
            { email },
            { $set: { role: "rider" } }
          );
        }

        res.json({ riderUpdate: result, roleUpdate: roleUpdateResult });
      } catch (error) {
        console.error("Error updating rider:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // ===================== PARCELS =====================
    app.post("/parcels", async (req, res) => {
      try {
        const result = await parcelCollection.insertOne(req.body);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to create parcel" });
      }
    });

    app.get("/my-parcels", verifyFbToken, verifyEmail, async (req, res) => {
      const email = req.query.email;
      try {
        const parcels = await parcelCollection
          .find({ "userDetails.userEmail": email })
          .sort({ Sending_date: -1 })
          .toArray();
        res.json(parcels);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch parcels" });
      }
    });
    app.get("/parcels/assignRider", verifyFbToken, async (req, res) => {
      const filter = {
        payment_status: "paid",
        delivery_status: "not-collected" ,
      };
      const result = await parcelCollection.find(filter).toArray();
      res.send(result);
    });

    app.get("/my-parcels/:id", verifyFbToken, async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid parcel ID" });
      }

      try {
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }
        res.json(parcel);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch parcel details" });
      }
    });

    app.delete("/my-parcels/:id", verifyFbToken, async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid parcel ID" });
      }

      try {
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to delete parcel" });
      }
    });
    app.patch(
      "/parcels/:id/assign",
      verifyFbToken,
      verifyAdmin,
      async (req, res) => {
        const { riderId, riderName } = req.body;
        const id = req.params.id;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            delivery_status: "in-transit",
            assign_rider_id: riderId,
            assign_rider_name: riderName,
          },
        };

        const parcelupdate = await parcelCollection.updateOne(
          filter,
          updateDoc
        );

        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { Work_status: "in_delivery" } }
        );

        res.send(parcelupdate);
      }
    );

    // ===================== STRIPE PAYMENT =====================
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      if (!amount || typeof amount !== "number") {
        return res.status(400).json({ message: "Invalid amount" });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ message: "Payment intent creation failed" });
      }
    });

    app.post("/payments", async (req, res) => {
      const { parcelId, amount, payment_method, transactionId, email } =
        req.body;
      if (!parcelId || !amount || !transactionId || !email) {
        return res.status(400).json({ message: "Missing payment info" });
      }

      try {
        const filter = { _id: new ObjectId(parcelId) };
        const updateDoc = { $set: { payment_status: "paid" } };

        const updateResult = await parcelCollection.updateOne(
          filter,
          updateDoc
        );
        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .json({ message: "Parcel not found or already paid" });
        }

        const paymentRecord = {
          parcelId,
          amount,
          payment_method,
          transactionId,
          email,
          paymentDate: new Date(),
        };

        const result = await paymentCollection.insertOne(paymentRecord);
        res.json(result);
      } catch (error) {
        console.error("Payment record error:", error);
        res.status(500).json({ message: "Payment processing failed" });
      }
    });

    app.get("/payments", verifyFbToken, verifyEmail, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res
          .status(400)
          .json({ message: "Email query parameter required" });
      }

      try {
        const payments = await paymentCollection.find({ email }).toArray();
        res.json(payments);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch payments" });
      }
    });

    // MongoDB ping test
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("Error in run():", error);
  }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Fast track server is running");
});

// Start server
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
